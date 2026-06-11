-- favorites: ranked "top 5" lists per user, one list for movies and one
-- for tv. One row per (user_id, media_type, rank) — five slots per
-- category, exactly one title per slot. Display joins to public.titles
-- via (tmdb_id, media_type), same shape as items / library.
--
-- RLS shape: owner + friends visibility. The friend-relationship check
-- reuses public.is_friend_of_auth (introduced with items in
-- 20260518123418_create_items) — the SAME helper items's
-- is_item_visible_to_auth calls internally. One source of truth for
-- "who counts as a friend"; a future change to that rule lands in one
-- place and applies everywhere (items / reviews / recommendations /
-- favorites).
--
-- Deliberately NO per-row visibility column. A curated top 5 is
-- implicitly a public-to-friends statement; "private slot" isn't a
-- meaningful product state (the user would just leave the title out).
-- If a private tier is ever needed, add a visibility text column with
-- a CHECK constraint and switch the SELECT policy to the
-- is_item_visible_to_auth shape — small, additive migration.
--
-- Writes are owner-only: INSERT / UPDATE / DELETE all gate on
-- user_id = auth.uid(), same shape as items / reviews.

-- ============================================================================
-- table
-- ============================================================================

create table public.favorites (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    media_type text not null,
    tmdb_id integer not null,
    rank integer not null,
    created_at timestamptz not null default now(),
    constraint favorites_media_type_check
        check (media_type in ('movie', 'tv')),
    constraint favorites_rank_range_check
        check (rank between 1 and 5),
    -- One title per rank slot per category per user. A re-rank that
    -- swaps two slots must do so atomically (the naive two-statement
    -- swap collides on the UNIQUE during the first UPDATE). At five
    -- slots max the simplest client pattern is to DELETE the whole
    -- category and INSERT the new ordering in one transaction;
    -- alternative is a single-statement bulk UPDATE using a CASE
    -- expression keyed on id.
    constraint favorites_user_media_rank_unique
        unique (user_id, media_type, rank),
    -- Can't list the same title twice in one category. Listing the
    -- same numeric tmdb_id under BOTH movie and tv categories is
    -- allowed (TMDB occasionally reuses numeric ids across the two
    -- catalogues for unrelated entries; media_type disambiguates).
    constraint favorites_user_media_tmdb_unique
        unique (user_id, media_type, tmdb_id)
);

-- Primary read access pattern is "load user X's top 5 for media_type M
-- ordered by rank" — fully covered by the
-- favorites_user_media_rank_unique index (leading columns user_id,
-- media_type). No extra indexes needed at MVP scale.

alter table public.favorites enable row level security;

-- ============================================================================
-- policies
-- ============================================================================

-- SELECT: own rows always; friend's rows always. The friend-relationship
-- check is the same is_friend_of_auth helper items uses internally — a
-- future change to "who counts as a friend" (mutual-only, blocked-users
-- carve-out, etc.) lands in one place and applies everywhere.
create policy "favorites_select_own_or_friend"
    on public.favorites
    for select
    to authenticated
    using (
        user_id = (select auth.uid())
        or public.is_friend_of_auth(user_id)
    );

-- INSERT/UPDATE/DELETE: own rows only. USING + WITH CHECK both pinned
-- on UPDATE so a user can't rewrite the user_id on a row they don't
-- own to claim it (matches the items / reviews pattern).
create policy "favorites_insert_own"
    on public.favorites
    for insert
    to authenticated
    with check (user_id = (select auth.uid()));

create policy "favorites_update_own"
    on public.favorites
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

create policy "favorites_delete_own"
    on public.favorites
    for delete
    to authenticated
    using (user_id = (select auth.uid()));

-- Table-level grant per TECHNICAL.md §2's two-layer model — RLS
-- policies don't evaluate without it. Same shape as items / titles
-- / reviews. service_role is intentionally NOT granted: no Edge
-- Function reads or writes favorites today, and the project-wide
-- lockdown posture says "open service_role access table-by-table
-- only when a function actually needs it."
grant select, insert, update, delete on public.favorites to authenticated;
