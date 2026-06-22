-- "Block user" for App Store Guideline 1.2 (Option B): blocking hides the two
-- users' content from EACH OTHER on the surfaces a reviewer checks — profiles
-- (world-readable) and existing shared recommendation threads (the note,
-- comments, reactions — these are PARTY-scoped, not friendship-scoped, so
-- unfriending alone does NOT hide them) — AND prevents new interaction. Block
-- also auto-unfriends, so every friendship-gated surface (items, reviews,
-- favorites, friend library) is hidden by the EXISTING friendship gate with no
-- change here. Reviewed by rls-auditor (PASS) before applying.
--
-- Design notes:
--   * All visibility helpers are AUTH-RELATIVE: they only ever consult blocks
--     involving auth.uid(), so a client can't probe whether two arbitrary
--     users have a block. The 2-arg base helper is_blocked_pair is NOT granted
--     to authenticated — it's called only from inside the SECURITY DEFINER
--     wrappers (which run as owner).
--   * All functions are SECURITY DEFINER with `set search_path = public`
--     pinned; identity comes from auth.uid(), never a client-supplied arg.
--   * Policy changes are drop+recreate (USING/WITH CHECK can't be ALTERed).
--     The whole migration is one transaction, so there's no window where a
--     policy is missing.

-- ============================================================================
-- blocks table
-- ============================================================================
create table public.blocks (
    -- FK -> public.profiles (project convention; cascades on account delete via
    -- profiles' own cascade from auth.users).
    blocker_id uuid not null references public.profiles (id) on delete cascade,
    blocked_id uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (blocker_id, blocked_id),
    constraint blocks_no_self check (blocker_id <> blocked_id)
);
-- PK (blocker_id, blocked_id) serves forward lookups; this serves the reverse
-- direction used by the symmetric (either-direction) block test.
create index blocks_blocked_idx on public.blocks (blocked_id, blocker_id);

alter table public.blocks enable row level security;

-- A user manages ONLY their own OUTGOING blocks. SELECT returns rows where
-- they are the blocker (for an unblock list) — there is intentionally NO
-- policy exposing rows where they are the blocked party, so the blocked user
-- cannot query the table to confirm they were blocked.
create policy "blocks_select_own"
    on public.blocks for select to authenticated
    using (blocker_id = (select auth.uid()));
create policy "blocks_insert_own"
    on public.blocks for insert to authenticated
    with check (blocker_id = (select auth.uid()));
create policy "blocks_delete_own"
    on public.blocks for delete to authenticated
    using (blocker_id = (select auth.uid()));

grant select, insert, delete on table public.blocks to authenticated;

-- ============================================================================
-- Helper functions
-- ============================================================================

-- Base: symmetric block test between two users (either direction).
-- INTERNAL ONLY — NOT granted to authenticated (prevents arbitrary-pair
-- probing). Called from the auth-relative wrappers below, which run as the
-- definer/owner and so may call it regardless of the authenticated grant.
create or replace function public.is_blocked_pair(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.blocks
        where (blocker_id = a and blocked_id = b)
           or (blocker_id = b and blocked_id = a)
    );
$$;
-- (no grant to authenticated — internal)

-- Auth-relative: is auth.uid() in a block with `other` (either direction)?
-- Only ever reveals blocks involving the caller.
create or replace function public.is_blocked_with_auth(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.is_blocked_pair((select auth.uid()), other);
$$;
grant execute on function public.is_blocked_with_auth(uuid) to authenticated;

-- Party-to-rec AND not blocked with the other party. Auth-relative: derives
-- me = auth.uid(), checks me is a party, and that no block exists between me
-- and the rec's OTHER party. Replaces is_party_to_rec in block-aware policies.
create or replace function public.is_party_to_rec_unblocked(rec_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null then
        return false;
    end if;
    return exists (
        select 1
        from public.recommendations r
        where r.id = rec_id
          and (r.from_user_id = me or r.to_user_id = me)
          and not public.is_blocked_pair(
              me,
              case when r.from_user_id = me then r.to_user_id else r.from_user_id end
          )
    );
end;
$$;
grant execute on function public.is_party_to_rec_unblocked(uuid) to authenticated;

-- Same, for a comment's parent rec.
create or replace function public.is_party_to_comment_unblocked(comment_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null then
        return false;
    end if;
    return exists (
        select 1
        from public.recommendation_comments c
        join public.recommendations r on r.id = c.recommendation_id
        where c.id = comment_id
          and (r.from_user_id = me or r.to_user_id = me)
          and not public.is_blocked_pair(
              me,
              case when r.from_user_id = me then r.to_user_id else r.from_user_id end
          )
    );
end;
$$;
grant execute on function public.is_party_to_comment_unblocked(uuid) to authenticated;

-- ============================================================================
-- SELECT policy changes — hide existing content between blocked users
-- ============================================================================

-- profiles: was world-readable for any non-deleted row. Add block exclusion.
-- (Own profile is always visible: is_blocked_pair(me, me) is impossible via
--  the blocks_no_self CHECK, so is_blocked_with_auth(my_id) = false.)
drop policy "profiles_select_active" on public.profiles;
create policy "profiles_select_active"
    on public.profiles for select to authenticated
    using (
        deleted_at is null
        and not public.is_blocked_with_auth(id)
    );

-- recommendations: party-scoped; add auth-relative block check on the other
-- party (inline, so no re-query of the row it's already scanning).
drop policy "recommendations_select_party" on public.recommendations;
create policy "recommendations_select_party"
    on public.recommendations for select to authenticated
    using (
        (
            from_user_id = (select auth.uid())
            or to_user_id = (select auth.uid())
        )
        and not public.is_blocked_with_auth(
            case
                when from_user_id = (select auth.uid()) then to_user_id
                else from_user_id
            end
        )
    );

-- recommendation_comments SELECT: swap is_party_to_rec -> _unblocked.
drop policy "comments_select_party" on public.recommendation_comments;
create policy "comments_select_party"
    on public.recommendation_comments for select to authenticated
    using (public.is_party_to_rec_unblocked(recommendation_id));

-- recommendation_reactions (rec-level) SELECT: swap to _unblocked.
drop policy "reactions_select_party" on public.recommendation_reactions;
create policy "reactions_select_party"
    on public.recommendation_reactions for select to authenticated
    using (public.is_party_to_rec_unblocked(recommendation_id));

-- recommendation_comment_reactions SELECT: swap to _unblocked.
drop policy "comment_reactions_select_party" on public.recommendation_comment_reactions;
create policy "comment_reactions_select_party"
    on public.recommendation_comment_reactions for select to authenticated
    using (public.is_party_to_comment_unblocked(comment_id));

-- ============================================================================
-- INSERT policy changes — prevent NEW interaction on existing threads
-- (party-scoped inserts do NOT check friendship/block, so a block must be
--  added explicitly here; unfriend alone does not stop these.)
-- ============================================================================

-- Comment on a shared thread.
drop policy "comments_insert_self_if_party" on public.recommendation_comments;
create policy "comments_insert_self_if_party"
    on public.recommendation_comments for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_rec_unblocked(recommendation_id)
    );

-- React to a rec (recipient-only rule preserved; add block check by ANDing the
-- existing recipient gate with the unblocked party check).
drop policy "reactions_insert_self_if_recipient" on public.recommendation_reactions;
create policy "reactions_insert_self_if_recipient"
    on public.recommendation_reactions for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_recipient_of_rec(recommendation_id)
        and public.is_party_to_rec_unblocked(recommendation_id)
    );

-- React to a comment.
drop policy "comment_reactions_insert_self_if_party" on public.recommendation_comment_reactions;
create policy "comment_reactions_insert_self_if_party"
    on public.recommendation_comment_reactions for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_comment_unblocked(comment_id)
    );

-- ----------------------------------------------------------------------------
-- DELIBERATE NON-CHANGE — reaction / comment-reaction UPDATE + DELETE policies.
--
-- The UPDATE/DELETE write policies on recommendation_reactions
-- (reactions_update_own_if_recipient / reactions_delete_own_if_recipient) and
-- recommendation_comment_reactions (comment_reactions_update_own_if_party /
-- comment_reactions_delete_own_if_party) intentionally STAY on the non-block
-- helpers (is_recipient_of_rec / is_party_to_comment). They act ONLY on the
-- caller's OWN row, expose nothing to the other party, and the row is already
-- SELECT-hidden from both sides by the swaps above — so a block check there
-- would add nothing. Left unchanged on purpose; do NOT "fix" them to the
-- _unblocked helpers for false consistency. (rls-auditor confirmed no leak.)
-- ----------------------------------------------------------------------------

-- Friend request: block a blocked user from re-initiating. Add an early block
-- check to can_send_friend_request (rest of the body unchanged).
create or replace function public.can_send_friend_request(target uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null or target is null or target = me then
        return false;
    end if;
    -- No friend requests across a block (either direction).
    if public.is_blocked_pair(me, target) then
        return false;
    end if;
    if exists (
        select 1 from public.friendships
        where user_a_id = least(me, target)
          and user_b_id = greatest(me, target)
    ) then
        return false;
    end if;
    if exists (
        select 1 from public.friend_requests
        where from_user_id = target and to_user_id = me
    ) then
        return false;
    end if;
    return true;
end;
$$;

-- Note: recommendations_insert_self_to_friend is intentionally NOT changed —
-- it already requires is_friend_of_auth(to_user_id), and block auto-unfriends
-- (and can_send_friend_request now blocks re-friending), so a blocked user
-- cannot become a friend to send a new rec. The friendship gate fully covers it.

-- ============================================================================
-- RPCs: block_user (atomic) + unblock_user
-- ============================================================================

-- Atomic: a plpgsql function runs in the caller's transaction, so if any
-- statement raises, ALL effects roll back — it can never leave "blocked but
-- still friends" or "friendship deleted but block insert failed".
create or replace function public.block_user(other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    if other_user_id is null or other_user_id = me then
        raise exception 'invalid block target';
    end if;

    -- 1. Record the block (re-block is a no-op).
    insert into public.blocks (blocker_id, blocked_id)
    values (me, other_user_id)
    on conflict (blocker_id, blocked_id) do nothing;

    -- 2. Unfriend (block implies not-friends).
    delete from public.friendships
    where user_a_id = least(me, other_user_id)
      and user_b_id = greatest(me, other_user_id);

    -- 3. Clear any pending friend requests in either direction.
    delete from public.friend_requests
    where (from_user_id = me and to_user_id = other_user_id)
       or (from_user_id = other_user_id and to_user_id = me);
end;
$$;
grant execute on function public.block_user(uuid) to authenticated;

-- Unblock removes only the block (does NOT re-friend — they'd re-add).
create or replace function public.unblock_user(other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    delete from public.blocks
    where blocker_id = me and blocked_id = other_user_id;
end;
$$;
grant execute on function public.unblock_user(uuid) to authenticated;
