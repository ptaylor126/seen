-- RECORD ONLY — applied by hand in the Supabase dashboard on 2026-07-10 and
-- verified (all four tables + both helper pairs present, kind-check widened
-- to thirteen kinds, RLS enabled on all four tables, PostgREST reloaded).
-- This file is the repo record; do NOT re-apply or run via the CLI.
--
-- "Chat about it" (step 2): a lightweight conversation thread about a title
-- between two friends, with NO recommendation semantics. Deliberately a
-- SEPARATE table cluster from recommendations (decision 2026-07-09): a kind
-- flag on recommendations would collide with recommendations_pair_unique
-- (a chat row would block a real rec of that title between that pair) and
-- with applyWatchedRating's open-recs sweep (chat rows would be transitioned
-- to watched and mis-notify). Structurally mirrors the proven rec-thread
-- pattern (20260605120000 + 20260607130000) with rec-only semantics removed:
-- no status lifecycle, no note, no is_decline_note / from_watched, no
-- immutability trigger (title_chats has no UPDATE policy or grant at all —
-- nothing is client-mutable).
--
-- DESIGN DIVERGENCES from the rec pattern (deliberate, see inline notes):
--   1. The pair-unique is DIRECTION-AGNOSTIC (least/greatest expression
--      index): a chat between A and B about a title IS one conversation —
--      B trying to start the mirror chat gets 23505 and the client should
--      open the existing chat instead (step 3 must handle this).
--   2. BOTH party FKs are NOT NULL ON DELETE CASCADE (recs anonymise the
--      sender via SET NULL). A rec is an artifact the recipient keeps; a
--      chat is a live two-party conversation with no meaning once either
--      party is gone — and the direction-agnostic index needs both columns
--      non-null. Under this cascade, chat_comments' SET NULL author can
--      never actually survive (both possible authors are parties whose
--      deletion removes the whole chat); kept anyway for shape-consistency
--      with recommendation_comments and the shared thread UI's null-author
--      handling.
--   3. chat_reactions writes are SYMMETRIC (both parties). Rec-level
--      reactions are recipient-only (20260607120000) because reacting to a
--      REC is the recipient responding to it; a chat has no recipient role.
--
-- BLOCK ENFORCEMENT (rls-audit 2026-07-09): this cluster mirrors the rec
-- thread AS RETROFITTED by 20260625120000, not as originally written —
-- SELECT policies exclude blocked pairs, and comment/reaction INSERTs use
-- the _unblocked party helpers, so after A blocks B the existing shared chat
-- disappears for both AND B cannot keep posting into it (which would
-- otherwise notify A — exactly the spam the block feature exists to stop).
-- UPDATE/DELETE stay on the plain party helpers (own-row-only writes,
-- already SELECT-hidden) and title_chats INSERT needs no block check —
-- is_friend_of_auth covers it (blocking auto-unfriends), both per the
-- documented non-changes in 20260625120000.
--
-- Dependencies (must already exist): public.profiles, public.is_friend_of_auth,
-- public.set_updated_at, public.is_blocked_pair, public.is_blocked_with_auth
-- (20260625120000), public.notifications (+ its kind CHECK — see §7).

-- ============================================================================
-- (1) title_chats — one conversation per (unordered friend pair, title)
-- ============================================================================

create table public.title_chats (
    id uuid primary key default gen_random_uuid(),
    -- The initiator ("from") and the friend they opened the chat with ("to").
    -- Direction is display-only (who started it); access and writes are
    -- symmetric. Both CASCADE — see header divergence note 2.
    from_user_id uuid not null references public.profiles(id) on delete cascade,
    to_user_id uuid not null references public.profiles(id) on delete cascade,
    tmdb_id integer not null,
    media_type text not null,
    created_at timestamptz not null default now(),
    constraint title_chats_media_type_check
        check (media_type in ('movie', 'tv')),
    constraint title_chats_no_self_check
        check (from_user_id <> to_user_id)
);

-- Direction-AGNOSTIC pair-unique (header divergence note 1): one chat per
-- unordered pair per title. An expression index (not a table constraint)
-- because least/greatest aren't allowed in a UNIQUE constraint. A duplicate
-- INSERT — either direction — fails 23505; the client should catch that and
-- open the existing chat.
create unique index title_chats_pair_title_unique
    on public.title_chats (
        least(from_user_id, to_user_id),
        greatest(from_user_id, to_user_id),
        tmdb_id,
        media_type
    );

-- Per-party lookups ("my chats"), mirroring the recs to/from indexes.
create index title_chats_from_user_idx on public.title_chats (from_user_id);
create index title_chats_to_user_idx on public.title_chats (to_user_id);

alter table public.title_chats enable row level security;

-- ============================================================================
-- (2) party predicate — clone of is_party_to_rec for the chat cluster.
-- SECURITY DEFINER because the helper queries title_chats regardless of how
-- the caller's RLS would resolve the join; the policy itself still enforces
-- party-membership.
-- ============================================================================

create or replace function public.is_party_to_chat(chat_id uuid)
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
        from public.title_chats
        where id = chat_id
          and (from_user_id = me or to_user_id = me)
    );
end;
$$;

-- Policy expressions invoke this helper in the caller's role — without the
-- EXECUTE grant every read/write 42501s before RLS even evaluates the row.
-- Mirrors the grant on is_party_to_rec.
grant execute on function public.is_party_to_chat(uuid) to authenticated;

-- Comment-level predicate — clone of is_party_to_comment.
create or replace function public.is_party_to_chat_comment(comment_id uuid)
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
        from public.chat_comments c
        join public.title_chats t on t.id = c.chat_id
        where c.id = comment_id
          and (t.from_user_id = me or t.to_user_id = me)
    );
end;
$$;

grant execute on function public.is_party_to_chat_comment(uuid) to authenticated;

-- Block-aware variants — party AND not blocked with the other party. Clones
-- of is_party_to_rec_unblocked / is_party_to_comment_unblocked (20260625120000).
-- Used by the SELECT policies on comments/reactions and ALL comment/reaction
-- INSERT policies; the plain helpers above remain for own-row UPDATE/DELETE.
create or replace function public.is_party_to_chat_unblocked(chat_id uuid)
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
        from public.title_chats t
        where t.id = chat_id
          and (t.from_user_id = me or t.to_user_id = me)
          and not public.is_blocked_pair(
              me,
              case when t.from_user_id = me then t.to_user_id else t.from_user_id end
          )
    );
end;
$$;

grant execute on function public.is_party_to_chat_unblocked(uuid) to authenticated;

create or replace function public.is_party_to_chat_comment_unblocked(comment_id uuid)
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
        from public.chat_comments c
        join public.title_chats t on t.id = c.chat_id
        where c.id = comment_id
          and (t.from_user_id = me or t.to_user_id = me)
          and not public.is_blocked_pair(
              me,
              case when t.from_user_id = me then t.to_user_id else t.from_user_id end
          )
    );
end;
$$;

grant execute on function public.is_party_to_chat_comment_unblocked(uuid) to authenticated;

-- ============================================================================
-- title_chats policies. SELECT: either party. INSERT: only as the initiator,
-- only to a friend (mirrors recommendations_insert_self_to_friend). NO update
-- policy or grant (nothing on the row is mutable — no status lifecycle) and
-- NO delete policy (chats are not user-deletable in v1; account deletion
-- cleans up via the party CASCADEs) — so no immutability trigger is needed.
-- ============================================================================

-- SELECT: either party, excluding blocked pairs (inline form mirroring the
-- retrofitted recommendations_select_party, 20260625120000) — after a block
-- the shared chat disappears for both parties.
create policy "title_chats_select_party"
    on public.title_chats
    for select
    to authenticated
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

create policy "title_chats_insert_self_to_friend"
    on public.title_chats
    for insert
    to authenticated
    with check (
        from_user_id = (select auth.uid())
        and public.is_friend_of_auth(to_user_id)
    );

grant select, insert on public.title_chats to authenticated;

-- ============================================================================
-- (3) chat_comments — flat, chronological. Same shape as
-- recommendation_comments MINUS the rec-only columns (no is_decline_note —
-- chats have no decline flow; no from_watched — no watched-sheet
-- integration). user_id ON DELETE SET NULL for shape-consistency (see header
-- divergence note 2); body caps match the rec comment caps. No UPDATE
-- policy — comments are immutable after INSERT; author-delete only.
-- ============================================================================

create table public.chat_comments (
    id uuid primary key default gen_random_uuid(),
    chat_id uuid not null
        references public.title_chats(id) on delete cascade,
    user_id uuid references public.profiles(id) on delete set null,
    body text not null,
    created_at timestamptz not null default now(),
    constraint chat_comments_body_length_check
        check (char_length(body) between 1 and 500),
    -- Length-only would allow "   ". Two CHECKs because btrim and
    -- char_length address different failure modes.
    constraint chat_comments_body_not_blank_check
        check (btrim(body) <> '')
);

create index chat_comments_chat_created_idx
    on public.chat_comments (chat_id, created_at);

alter table public.chat_comments enable row level security;

-- SELECT/INSERT use the _unblocked helper: a blocked party can neither read
-- the thread nor keep posting into it (each post would notify the blocker).
create policy "chat_comments_select_party"
    on public.chat_comments
    for select
    to authenticated
    using (public.is_party_to_chat_unblocked(chat_id));

create policy "chat_comments_insert_self_if_party"
    on public.chat_comments
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_chat_unblocked(chat_id)
    );

-- Deliberately NO update policy — comments are immutable after INSERT.
-- Author-delete only; edits are delete-and-repost.
create policy "chat_comments_delete_own"
    on public.chat_comments
    for delete
    to authenticated
    using (user_id = (select auth.uid()));

grant select, insert, delete on public.chat_comments to authenticated;

-- ============================================================================
-- (4a) chat_reactions — one row per (chat, user); change = UPDATE, remove =
-- DELETE. Same shape as recommendation_reactions; emoji CHECK must stay in
-- sync with the client REACTION_EMOJIS array (src/components/thread/shared.ts).
-- Writes are symmetric (both parties) — see header divergence note 3.
-- ============================================================================

create table public.chat_reactions (
    chat_id uuid not null
        references public.title_chats(id) on delete cascade,
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    emoji text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (chat_id, user_id),
    constraint chat_reactions_emoji_check
        check (emoji in ('👍','❤️','😂','😮','👀'))
);

create trigger chat_reactions_set_updated_at
    before update on public.chat_reactions
    for each row execute function public.set_updated_at();

alter table public.chat_reactions enable row level security;

-- SELECT/INSERT block-aware; UPDATE/DELETE below stay on the plain helper
-- (own-row-only writes, already SELECT-hidden across a block) — same
-- deliberate non-change as the rec cluster's 20260625120000 retrofit.
create policy "chat_reactions_select_party"
    on public.chat_reactions
    for select
    to authenticated
    using (public.is_party_to_chat_unblocked(chat_id));

create policy "chat_reactions_insert_self_if_party"
    on public.chat_reactions
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_chat_unblocked(chat_id)
    );

create policy "chat_reactions_update_own_if_party"
    on public.chat_reactions
    for update
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_party_to_chat(chat_id)
    )
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_chat(chat_id)
    );

create policy "chat_reactions_delete_own_if_party"
    on public.chat_reactions
    for delete
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_party_to_chat(chat_id)
    );

grant select, insert, update, delete
    on public.chat_reactions to authenticated;

-- ============================================================================
-- (4b) chat_comment_reactions — INCLUDED in v1 (not skipped): it is a
-- verbatim structural clone of recommendation_comment_reactions
-- (20260607130000), and the extracted shared thread UI (ThreadCommentList
-- chips + ThreadCommentMenu emoji row) assumes comment reactions exist —
-- omitting it would make the chat screen's long-press react a write error.
-- ============================================================================

create table public.chat_comment_reactions (
    comment_id uuid not null
        references public.chat_comments(id) on delete cascade,
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    emoji text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (comment_id, user_id),
    constraint chat_comment_reactions_emoji_check
        check (emoji in ('👍','❤️','😂','😮','👀'))
);

create trigger chat_comment_reactions_set_updated_at
    before update on public.chat_comment_reactions
    for each row execute function public.set_updated_at();

alter table public.chat_comment_reactions enable row level security;

-- SELECT/INSERT block-aware (comment-level helper); UPDATE/DELETE stay plain.
create policy "chat_comment_reactions_select_party"
    on public.chat_comment_reactions
    for select
    to authenticated
    using (public.is_party_to_chat_comment_unblocked(comment_id));

create policy "chat_comment_reactions_insert_self_if_party"
    on public.chat_comment_reactions
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_chat_comment_unblocked(comment_id)
    );

create policy "chat_comment_reactions_update_own_if_party"
    on public.chat_comment_reactions
    for update
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_party_to_chat_comment(comment_id)
    )
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_chat_comment(comment_id)
    );

create policy "chat_comment_reactions_delete_own_if_party"
    on public.chat_comment_reactions
    for delete
    to authenticated
    using (
        user_id = (select auth.uid())
        and public.is_party_to_chat_comment(comment_id)
    );

grant select, insert, update, delete
    on public.chat_comment_reactions to authenticated;

-- ============================================================================
-- (7) notifications — widen the kind CHECK to include the three chat kinds.
--
-- LIVE OBJECT — verify before running. Fetch the CURRENT live definition:
--
--     select pg_get_constraintdef(oid)
--     from pg_constraint
--     where conname = 'notifications_kind_check';
--
-- Expected (per the repo, last widened by 20260706120000): the ten kinds
-- rec_received, rec_watched, friend_request, friend_accepted, rec_reacted,
-- rec_commented, comment_reacted, rec_declined, rec_requested, report_filed.
-- If the live output lists anything ELSE, STOP — the recreate below would
-- erase that drift (the create-or-replace lesson, 2026-07-09) — reconcile
-- first.
-- ============================================================================

alter table public.notifications
    drop constraint notifications_kind_check;

alter table public.notifications
    add constraint notifications_kind_check
    check (kind in (
        'rec_received',
        'rec_watched',
        'friend_request',
        'friend_accepted',
        'rec_reacted',
        'rec_commented',
        'comment_reacted',
        'rec_declined',
        'rec_requested',
        'report_filed',
        'chat_commented',
        'chat_reacted',
        'chat_comment_reacted'
    ));

-- ============================================================================
-- (6) notify triggers — clones of the rec thread's, with chat kinds and a
-- chat_id payload key (NOT recommendation_id). All SECURITY DEFINER so the
-- notifications insert bypasses the caller's RLS; reactions fire on INSERT
-- only (changes/removals are silent); comments fire on every INSERT.
-- Self-notification is impossible by construction — target is "the party
-- that isn't the actor" — but the equality guard is defence in depth.
--
-- No separate chat_started kind: the first message IS the announcement (the
-- other party gets chat_commented for it).
-- ============================================================================

create or replace function public.notify_chat_commented()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    chat public.title_chats%rowtype;
    target uuid;
begin
    select * into chat from public.title_chats where id = new.chat_id;
    if not found then
        return null;
    end if;

    target := case
        when new.user_id = chat.to_user_id then chat.from_user_id
        else chat.to_user_id
    end;
    if target is null or target = new.user_id then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        target,
        'chat_commented',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'chat_id', new.chat_id,
            'comment_id', new.id,
            'tmdb_id', chat.tmdb_id,
            'media_type', chat.media_type
        )
    );
    return null;
end;
$$;

create trigger chat_comments_notify_commented
    after insert on public.chat_comments
    for each row execute function public.notify_chat_commented();

create or replace function public.notify_chat_reacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    chat public.title_chats%rowtype;
    target uuid;
begin
    select * into chat from public.title_chats where id = new.chat_id;
    if not found then
        return null;
    end if;

    target := case
        when new.user_id = chat.to_user_id then chat.from_user_id
        else chat.to_user_id
    end;
    if target is null or target = new.user_id then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        target,
        'chat_reacted',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'chat_id', new.chat_id,
            'emoji', new.emoji,
            'tmdb_id', chat.tmdb_id,
            'media_type', chat.media_type
        )
    );
    return null;
end;
$$;

create trigger chat_reactions_notify_reacted
    after insert on public.chat_reactions
    for each row execute function public.notify_chat_reacted();

-- Notify the comment's author when the other party reacts — mirrors
-- notify_comment_reacted (self-reactions and deleted authors suppressed).
create or replace function public.notify_chat_comment_reacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    comment public.chat_comments%rowtype;
    chat public.title_chats%rowtype;
begin
    select * into comment from public.chat_comments where id = new.comment_id;
    if not found then
        return null;
    end if;

    if comment.user_id is null or comment.user_id = new.user_id then
        return null;
    end if;

    select * into chat from public.title_chats where id = comment.chat_id;
    if not found then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        comment.user_id,
        'chat_comment_reacted',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'chat_id', comment.chat_id,
            'comment_id', new.comment_id,
            'emoji', new.emoji,
            'tmdb_id', chat.tmdb_id,
            'media_type', chat.media_type
        )
    );
    return null;
end;
$$;

create trigger chat_comment_reactions_notify_reacted
    after insert on public.chat_comment_reactions
    for each row execute function public.notify_chat_comment_reacted();

-- ============================================================================
-- service_role grants — up-front, per the grant-per-edge-function lesson
-- (JOURNAL tech debt: newer Supabase projects have NO default service_role
-- privileges on public.*; discovering grants symptom-by-symptom costs a
-- debugging session each time). send-push-notification will need chat_comments
-- (comment-body preview for chat_commented pushes, mirroring fetchCommentBody)
-- and possibly title_chats (chat lookups); both are read-only.
-- ============================================================================

grant select on public.title_chats to service_role;
grant select on public.chat_comments to service_role;
