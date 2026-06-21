-- Account deletion (Apple guideline 5.1.1(v)) — the database half.
--
-- delete_account_data(p_uid) performs every DB delete that the auth-user
-- cascade does NOT do correctly on its own, in ONE transaction. The
-- Edge Function `delete-account` calls this (with the uid derived from the
-- caller's verified JWT), then removes the caller's Storage objects, then
-- calls auth.admin.deleteUser(uid) LAST. The auth-user deletion cascades
-- the rest (profile → items, reviews, favorites, invite_links,
-- push_tokens, friendships, friend_requests, received recs, own
-- notifications/reactions, …).
--
-- Why these specific statements (the cascade is wrong or absent for them):
--   - recommendations.from_user_id is ON DELETE SET NULL (anonymise) — the
--     old PRD policy. New policy DELETES sent recs, so we do it explicitly.
--   - recommendation_comments.user_id is ON DELETE SET NULL (preserve) —
--     new policy DELETES the user's comments, so explicit.
--   - notifications carry the user's id in JSONB payload (no FK) in OTHER
--     users' inboxes — cascade can't reach those; we sweep them.
--   - feedback.user_id is ON DELETE SET NULL (retain) — new policy DELETES
--     feedback rows (screenshots are removed by the Edge Function).
--   - the handle must be released into handle_history (90-day cooldown) so
--     deletion can't bypass the normal handle-change lock.
--
-- TRANSACTION: a plpgsql function body runs inside the caller's
-- transaction, so every statement here commits together or not at all — a
-- mid-way failure rolls the whole thing back (the account still exists and
-- the call can be retried).
--
-- IDEMPOTENT: every statement is WHERE-filtered or ON CONFLICT, so
-- re-running after a partial/failed run only ever deletes already-gone
-- rows (0 rows, no error) or refreshes the handle cooldown. Safe to retry
-- to completion.
--
-- SECURITY: SECURITY DEFINER + locked search_path. EXECUTE is granted to
-- service_role ONLY (revoked from public/authenticated/anon) — the
-- function takes a uid argument, so leaving it callable by clients would
-- let any authenticated user delete anyone's data. Only the Edge Function
-- (service role), which passes the JWT-derived uid, may call it.

create or replace function public.delete_account_data(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_handle text;
begin
    if p_uid is null then
        raise exception 'p_uid is required';
    end if;

    -- 1. Notifications: this user's own inbox rows AND any row in ANOTHER
    --    user's inbox that names this user in its JSONB payload
    --    (payload->>'from_user_id'), e.g. "X reacted / commented /
    --    recommended". Removes the user's identity from other inboxes.
    --    (Own rows also cascade later via auth deletion; deleting here too
    --    is a harmless no-op then.)
    delete from public.notifications
    where user_id = p_uid
       or payload->>'from_user_id' = p_uid::text;

    -- 2. Feedback rows authored by this user (override the SET NULL retain).
    --    The screenshot objects in the private 'feedback' bucket are removed
    --    by the Edge Function's Storage step.
    delete from public.feedback
    where user_id = p_uid;

    -- 3. The user's reactions on comments, and on recs, in shared threads.
    --    (Both FKs are ON DELETE CASCADE from the profile, so auth deletion
    --    would also remove them — explicit here per policy and to keep the
    --    whole delete in one transaction.)
    delete from public.recommendation_comment_reactions
    where user_id = p_uid;

    delete from public.recommendation_reactions
    where user_id = p_uid;

    -- 4. The user's comments in shared rec threads (override the SET NULL
    --    "deleted user" preserve — new policy removes them).
    delete from public.recommendation_comments
    where user_id = p_uid;

    -- 5. Recs the user SENT (pending AND accepted). Deleting the rec row
    --    strips the recipient's join-derived "recommended by" attribution
    --    automatically; the recipient's items row is a different user's row
    --    and is untouched. This cascades any remaining reactions/comments
    --    on those recs (recommendation_id ON DELETE CASCADE). Received recs
    --    (to_user_id = p_uid) are left to the auth-deletion cascade.
    delete from public.recommendations
    where from_user_id = p_uid;

    -- 6. Release the handle into handle_history with the standard 90-day
    --    cooldown so deletion can't bypass the handle-change lock. Read
    --    from the still-present profile (auth deletion happens AFTER this
    --    RPC). If the profile is already gone (a retry after auth deletion
    --    succeeded), v_handle is null and we skip. ON CONFLICT refreshes the
    --    cooldown if the handle was already in the history table.
    select handle into v_handle from public.profiles where id = p_uid;
    if v_handle is not null then
        insert into public.handle_history (handle, released_at, available_at)
        values (lower(v_handle), now(), now() + interval '90 days')
        on conflict (handle) do update
            set released_at = excluded.released_at,
                available_at = excluded.available_at;
    end if;
end;
$$;

-- Lock execution to the service role only. The Edge Function calls this
-- with the service-role key and a JWT-verified uid; no client should be
-- able to call it with an arbitrary uid.
revoke all on function public.delete_account_data(uuid) from public;
revoke all on function public.delete_account_data(uuid) from anon;
revoke all on function public.delete_account_data(uuid) from authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;

-- ============================================================================
-- Tighten enforce_recommendation_immutability: from_user_id is now fully
-- immutable.
--
-- The original trigger (20260518130612) allowed a from_user_id non-null →
-- NULL transition under a privileged role, to support the OLD account-
-- deletion policy of ANONYMISING sent recs (SET NULL). The new policy
-- HARD-DELETES sent recs (see delete_account_data above), so that
-- transition never happens — the carve-out is dead code in a security
-- trigger. Removing it restores a simple "from_user_id can never change"
-- invariant with no unreachable exception path. Body is otherwise
-- identical to the original.
-- ============================================================================
create or replace function public.enforce_recommendation_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.id is distinct from old.id then
        raise exception 'cannot change id of a recommendation';
    end if;
    if new.from_user_id is distinct from old.from_user_id then
        raise exception 'cannot change from_user_id of a recommendation';
    end if;
    if new.to_user_id is distinct from old.to_user_id then
        raise exception 'cannot change to_user_id of a recommendation';
    end if;
    if new.tmdb_id is distinct from old.tmdb_id then
        raise exception 'cannot change tmdb_id of a recommendation';
    end if;
    if new.media_type is distinct from old.media_type then
        raise exception 'cannot change media_type of a recommendation';
    end if;
    if new.note is distinct from old.note then
        raise exception 'cannot change note of a recommendation';
    end if;
    if new.sent_at is distinct from old.sent_at then
        raise exception 'cannot change sent_at of a recommendation';
    end if;
    return new;
end;
$$;
