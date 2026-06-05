-- recommendation_reactions + recommendation_comments + party predicate +
-- notification kinds + notify triggers
-- PRD.md (recommendations reactions/comments scope discussed 2026-06-05)
-- TECHNICAL.md §1 (schema), §2 (RLS), §3 (functions)

-- ============================================================================
-- party predicate — wrapped like is_friend_of_auth so the per-table policies
-- read cleanly. security definer because the helper queries recommendations
-- regardless of how the caller's RLS would resolve the join; the policy
-- itself still enforces party-membership.
-- ============================================================================

create or replace function public.is_party_to_rec(rec_id uuid)
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
        from public.recommendations
        where id = rec_id
          and (from_user_id = me or to_user_id = me)
    );
end;
$$;

-- Policy expressions on recommendation_reactions / recommendation_comments
-- invoke this helper in the caller's role (SECURITY DEFINER controls the
-- function body, not who's permitted to call it). Without the EXECUTE
-- grant every read/write against either table 42501s before RLS even
-- evaluates the row. Mirrors the explicit grant on is_friend_of_auth in
-- 20260519102336_grant_authenticated_privileges_on_public_tables.sql.
grant execute on function public.is_party_to_rec(uuid) to authenticated;

-- ============================================================================
-- recommendation_reactions — one row per (rec, user); change = UPDATE,
-- remove = DELETE. Emoji set locked via CHECK; widening is a one-line
-- migration. user_id ON DELETE CASCADE: an anonymised emoji carries no
-- value, so wipe rather than orphan.
-- ============================================================================

create table public.recommendation_reactions (
    recommendation_id uuid not null
        references public.recommendations(id) on delete cascade,
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    emoji text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (recommendation_id, user_id),
    constraint recommendation_reactions_emoji_check
        check (emoji in ('👍','❤️','😂','😮','👀'))
);

-- (recommendation_id, user_id) PK already provides a per-rec lookup
-- via the leading column, so no extra index needed there.

create trigger recommendation_reactions_set_updated_at
    before update on public.recommendation_reactions
    for each row execute function public.set_updated_at();

alter table public.recommendation_reactions enable row level security;

-- SELECT: any party to the rec sees all reactions on it (i.e. both
-- parties see each other's reaction). Non-parties see nothing.
create policy "reactions_select_party"
    on public.recommendation_reactions
    for select
    to authenticated
    using (public.is_party_to_rec(recommendation_id));

-- INSERT: only your own row, and only on a rec you're a party to.
create policy "reactions_insert_self_if_party"
    on public.recommendation_reactions
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_rec(recommendation_id)
    );

-- UPDATE: change your emoji on your row. The PK pins (rec, user) so
-- the row identity can't drift; only `emoji` is meaningful to update.
create policy "reactions_update_own"
    on public.recommendation_reactions
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- DELETE: remove your reaction.
create policy "reactions_delete_own"
    on public.recommendation_reactions
    for delete
    to authenticated
    using (user_id = (select auth.uid()));

grant select, insert, update, delete
    on public.recommendation_reactions to authenticated;

-- ============================================================================
-- recommendation_comments — flat, chronological. user_id ON DELETE SET
-- NULL so the comment body survives author deletion (renders as "deleted
-- user" in the UI); body length matches the rec note cap. No edits in v1,
-- so no UPDATE policy.
-- ============================================================================

create table public.recommendation_comments (
    id uuid primary key default gen_random_uuid(),
    recommendation_id uuid not null
        references public.recommendations(id) on delete cascade,
    user_id uuid references public.profiles(id) on delete set null,
    body text not null,
    created_at timestamptz not null default now(),
    constraint recommendation_comments_body_length_check
        check (char_length(body) between 1 and 500),
    -- Length-only would allow "   ". Two CHECKs because btrim and
    -- char_length address different failure modes.
    constraint recommendation_comments_body_not_blank_check
        check (btrim(body) <> '')
);

create index recommendation_comments_rec_created_idx
    on public.recommendation_comments (recommendation_id, created_at);

alter table public.recommendation_comments enable row level security;

create policy "comments_select_party"
    on public.recommendation_comments
    for select
    to authenticated
    using (public.is_party_to_rec(recommendation_id));

create policy "comments_insert_self_if_party"
    on public.recommendation_comments
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and public.is_party_to_rec(recommendation_id)
    );

-- Deliberately NO update policy — comments are immutable after INSERT.
-- Author-delete only; edits are delete-and-repost.
create policy "comments_delete_own"
    on public.recommendation_comments
    for delete
    to authenticated
    using (user_id = (select auth.uid()));

grant select, insert, delete on public.recommendation_comments to authenticated;

-- ============================================================================
-- notifications — widen the kind CHECK to include the two new kinds.
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
        'rec_commented'
    ));

-- ============================================================================
-- triggers — notify the OTHER party on reaction INSERT and comment INSERT.
-- Per plan: reactions fire on INSERT only (changes/removals are silent);
-- comments fire on every INSERT (debounce window is a known follow-up).
-- Self-notification is impossible by construction — target is "the party
-- that isn't the actor" — but the equality guard is defence in depth for
-- the anonymised-sender edge case.
-- ============================================================================

create or replace function public.notify_recommendation_reacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    rec public.recommendations%rowtype;
    target uuid;
begin
    select * into rec from public.recommendations where id = new.recommendation_id;
    if not found then
        return null;
    end if;

    -- Other party = whoever isn't the reactor. NULL from_user_id means
    -- the sender's account was deleted (anonymised per PRD §5); nobody
    -- to notify in that case.
    target := case
        when new.user_id = rec.to_user_id then rec.from_user_id
        else rec.to_user_id
    end;
    if target is null or target = new.user_id then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        target,
        'rec_reacted',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'recommendation_id', new.recommendation_id,
            'emoji', new.emoji,
            'tmdb_id', rec.tmdb_id,
            'media_type', rec.media_type
        )
    );
    return null;
end;
$$;

create trigger reactions_notify_reacted
    after insert on public.recommendation_reactions
    for each row execute function public.notify_recommendation_reacted();

create or replace function public.notify_recommendation_commented()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    rec public.recommendations%rowtype;
    target uuid;
begin
    select * into rec from public.recommendations where id = new.recommendation_id;
    if not found then
        return null;
    end if;

    target := case
        when new.user_id = rec.to_user_id then rec.from_user_id
        else rec.to_user_id
    end;
    if target is null or target = new.user_id then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        target,
        'rec_commented',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'recommendation_id', new.recommendation_id,
            'comment_id', new.id,
            'tmdb_id', rec.tmdb_id,
            'media_type', rec.media_type
        )
    );
    return null;
end;
$$;

create trigger comments_notify_commented
    after insert on public.recommendation_comments
    for each row execute function public.notify_recommendation_commented();
