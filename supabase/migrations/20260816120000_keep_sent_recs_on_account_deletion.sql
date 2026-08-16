-- Account deletion policy change: KEEP recommendations the deleted user
-- SENT, de-identified, instead of hard-deleting them.
--
-- Rationale: a received recommendation lives in the RECIPIENT's inbox and
-- history — it is partly their data. Deleting the sender should remove the
-- sender's identity, not the recipient's record of what was recommended to
-- them. This restores the original PRD §5 anonymisation policy that
-- 20260622120000 replaced with hard-delete.
--
-- Mechanics: delete_account_data simply stops deleting sent recs. The
-- existing FK (recommendations.from_user_id → profiles ON DELETE SET NULL)
-- then de-identifies them automatically when the profile cascades away with
-- the auth user, and the client already renders a null sender gracefully
-- ("Former user" in the inbox and rec detail; UserLink goes inert).
--
-- No trigger change is needed: enforce_recommendation_immutability's
-- privileged-role carve-out for the from_user_id non-null → NULL transition
-- (required because referential SET NULL fires the trigger as a normal
-- UPDATE) was removed by 20260622120000 as dead code but RESTORED by
-- 20260714150000 alongside the season-immutability check — verified against
-- the live definition 2026-08-16. The SET NULL cascade runs as
-- supabase_auth_admin during auth.admin.deleteUser, which passes the
-- carve-out's role check; client roles never can.
--
-- What still happens on deletion (unchanged from 20260622120000):
--   - notifications sweep (own inbox + rows in OTHER inboxes naming the
--     user in payload) — so the "X recommended…" notification is
--     de-identified away even though the rec itself survives;
--   - the deleted user's own comments/reactions on rec threads are
--     deleted — without this, their SET NULL comment rows would survive
--     anonymised on the now-surviving recs;
--   - feedback rows deleted; handle released into handle_history with the
--     90-day cooldown.
--
-- Policy note, decided with this migration: the sender-authored `note` on
-- a kept rec SURVIVES in the recipient's inbox (received-correspondence
-- model, like an email you keep after the sender closes their account).

-- delete_account_data — identical to 20260622120000 except the sent-
-- recommendations DELETE is removed (old step 5).
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

    -- 4. The user's comments in shared rec threads. user_id is ON DELETE
    --    SET NULL, and sent recs now SURVIVE deletion — without this
    --    explicit delete, the user's comment text would linger anonymised
    --    on those surviving recs.
    delete from public.recommendation_comments
    where user_id = p_uid;

    -- 5. Sent recommendations are deliberately NOT deleted (policy change,
    --    this migration): they are the recipient's inbox/history. The FK
    --    ON DELETE SET NULL de-identifies from_user_id when the profile
    --    cascades away, and the client renders the null sender as
    --    "Former user". Received recs (to_user_id = p_uid) are left to the
    --    auth-deletion cascade, as before.

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

-- Grants unchanged from 20260622120000 (CREATE OR REPLACE preserves ACLs;
-- re-stated for self-documentation): service-role only — the function takes
-- a uid argument, so any client-callable grant would be a delete-anyone hole.
revoke all on function public.delete_account_data(uuid) from public;
revoke all on function public.delete_account_data(uuid) from anon;
revoke all on function public.delete_account_data(uuid) from authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
