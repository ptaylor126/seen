-- Reviews table + per-item visibility (text enum, forward-compatible).
--
-- This migration does four things:
--
-- (1) Migrate items.is_private (boolean) -> items.visibility (text). The
--     existing boolean only handles two states ('private', 'friends-
--     visible'). The product direction is to leave room for a 'public'
--     tier later without another migration, so the column type widens
--     to text with a CHECK that we extend by editing one constraint.
--     Boolean is mapped: is_private=true -> 'private', false -> 'friends'.
--
-- (2) Introduce a `is_item_visible_to_auth(item_user_id, item_visibility)`
--     security-definer helper mirroring the shape of is_party_to_rec /
--     is_party_to_comment / is_recipient_of_rec. It consolidates the
--     "can the current auth user see this row" rule: author OR
--     (visibility = 'friends' AND viewer is a friend of the author).
--     Both items and reviews use it; future tables governed by the same
--     per-item visibility can use it too.
--
-- (3) Rewrite items's SELECT policy to call the helper against
--     (user_id, visibility). Behaviour is preserved exactly under
--     today's two-value enum.
--
-- (4) Create the reviews table. One row per (user_id, tmdb_id, media_type)
--     -- matches items's identity tuple. SELECT delegates to items's own
--     RLS via an EXISTS into items, so visibility is governed in ONE
--     place (the parent item) rather than two. INSERT/UPDATE/DELETE are
--     author-only by user_id = auth.uid().

-- ============================================================================
-- (1) items.is_private -> items.visibility
-- ============================================================================

alter table public.items
    add column visibility text not null default 'friends'
        constraint items_visibility_check
            check (visibility in ('private', 'friends'));

-- Backfill from the existing boolean. The column default already covers
-- the friends side, but doing the UPDATE explicitly keeps the migration
-- self-documenting and is correct even for rows where someone explicitly
-- set is_private=false (vs. defaulting to false).
update public.items
    set visibility = case when is_private then 'private' else 'friends' end;

-- The SELECT policy references is_private; drop it before the column.
-- INSERT/UPDATE/DELETE policies are user_id-scoped and do not reference
-- is_private, so they stay.
drop policy "items_select_own_or_friend_public" on public.items;

alter table public.items drop column is_private;

-- ============================================================================
-- (2) Visibility helper
-- ============================================================================

-- Same shape as is_party_to_rec / is_party_to_comment / is_recipient_of_rec:
-- stable, security definer, search_path locked, NULL-uid guard. Reuses the
-- existing is_friend_of_auth helper (introduced with the items table) for
-- the friendship check; the rule for friends-tier visibility is exactly
-- that and nothing else.
create or replace function public.is_item_visible_to_auth(
    item_user_id uuid,
    item_visibility text
)
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
    -- Author always sees own item, regardless of visibility setting.
    if item_user_id = me then
        return true;
    end if;
    -- Non-author sees only when the item is explicitly marked
    -- friends-visible AND the viewer is a confirmed friend of the
    -- author. When 'public' is added later it goes on the right side
    -- of the OR with no friendship requirement.
    return item_visibility = 'friends'
        and public.is_friend_of_auth(item_user_id);
end;
$$;

-- Mirrors the EXECUTE grant pattern on is_party_to_rec etc. — without
-- it, callers under the authenticated role error 42501 before RLS even
-- evaluates the row.
grant execute on function public.is_item_visible_to_auth(uuid, text)
    to authenticated;

-- ============================================================================
-- (3) New items SELECT policy (functionally identical under today's enum)
-- ============================================================================

create policy "items_select_own_or_friend_visible"
    on public.items
    for select
    to authenticated
    using (public.is_item_visible_to_auth(user_id, visibility));

-- ============================================================================
-- (4) reviews table
-- ============================================================================

create table public.reviews (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null
        references public.profiles(id) on delete cascade,
    tmdb_id integer not null,
    media_type text not null,
    body text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint reviews_media_type_check
        check (media_type in ('movie', 'tv')),
    -- One review per user per title — matches items's identity tuple.
    constraint reviews_user_tmdb_media_unique
        unique (user_id, tmdb_id, media_type),
    -- Mirrors recommendation_comments's body shape: length-capped AND
    -- not-blank (length-only would allow "   "). 5000 chars is roughly
    -- 800 words, generous for a "what did I think" note without
    -- becoming a blog post.
    constraint reviews_body_length_check
        check (char_length(body) between 1 and 5000),
    constraint reviews_body_not_blank_check
        check (btrim(body) <> '')
);

create index reviews_user_id_idx on public.reviews (user_id);

-- updated_at maintained by the shared set_updated_at trigger function
-- introduced with items.
create trigger reviews_set_updated_at
    before update on public.reviews
    for each row execute function public.set_updated_at();

alter table public.reviews enable row level security;

-- SELECT: author always sees own; non-authors see only when the parent
-- items row is visible to them. We DELEGATE to items's own SELECT
-- policy via an EXISTS subquery rather than re-implementing the
-- visibility check here. Two benefits:
--   - one source of truth for "can I see this title's library row"
--     -- items's RLS. Future visibility changes (e.g. a 'public' tier)
--     land in one place.
--   - if the parent item is deleted (e.g. library toggle-off), the
--     review naturally becomes invisible to non-authors. Author still
--     sees their own review via the first branch of the OR.
create policy "reviews_select_own_or_visible_via_item"
    on public.reviews
    for select
    to authenticated
    using (
        user_id = (select auth.uid())
        or exists (
            select 1
            from public.items i
            where i.user_id = reviews.user_id
              and i.tmdb_id = reviews.tmdb_id
              and i.media_type = reviews.media_type
        )
    );

create policy "reviews_insert_self"
    on public.reviews
    for insert
    to authenticated
    with check (user_id = (select auth.uid()));

-- USING + WITH CHECK both pinned to author. WITH CHECK alone would let
-- a user UPDATE a row they don't own as long as the new user_id is
-- themselves — i.e. "steal" someone else's review row id. The USING
-- clause closes that.
create policy "reviews_update_own"
    on public.reviews
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

create policy "reviews_delete_own"
    on public.reviews
    for delete
    to authenticated
    using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.reviews to authenticated;
