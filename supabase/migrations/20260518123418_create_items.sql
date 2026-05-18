-- items + generic updated_at trigger + friendship visibility helper
-- TECHNICAL.md §1 (schema), §2 (RLS)

-- ============================================================================
-- generic updated_at trigger function (reused by future tables)
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- ============================================================================
-- items
-- ============================================================================

create table public.items (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    tmdb_id integer not null,
    media_type text not null,
    status text not null,
    rating integer,
    is_private boolean not null default false,
    watched_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint items_media_type_check
        check (media_type in ('movie', 'tv')),
    constraint items_status_check
        check (status in ('watchlist', 'watching', 'watched')),
    constraint items_rating_range_check
        check (rating is null or rating between 1 and 5),
    constraint items_rating_only_when_watched_check
        check (status = 'watched' or rating is null),
    constraint items_user_tmdb_media_unique
        unique (user_id, tmdb_id, media_type)
);

create index items_user_id_idx on public.items (user_id);
create index items_user_status_idx on public.items (user_id, status);
create index items_user_is_private_idx on public.items (user_id, is_private);

create trigger items_set_updated_at
    before update on public.items
    for each row execute function public.set_updated_at();

alter table public.items enable row level security;

-- ============================================================================
-- friendship visibility helper
-- ============================================================================

-- Wrapped in a plpgsql function so we can reference public.friendships before
-- that table exists: plpgsql defers name resolution until first execution.
-- The items SELECT policy uses this for the friend-visibility branch. Calls
-- will raise "relation does not exist" until the friendships migration runs
-- — that is expected and matches the planned migration order.
--
-- security definer is intentional so the function bypasses RLS on
-- friendships once that table lands and gets its own own-row-only SELECT
-- policy: the helper queries by (least, greatest) and must succeed for any
-- pair where auth.uid() is one endpoint, which own-row RLS would already
-- allow, but security definer keeps the check robust to future RLS changes.
create or replace function public.is_friend_of_auth(other_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null or other_user is null or me = other_user then
        return false;
    end if;
    return exists (
        select 1
        from public.friendships
        where user_a_id = least(me, other_user)
          and user_b_id = greatest(me, other_user)
    );
end;
$$;

-- ============================================================================
-- policies
-- ============================================================================

-- SELECT: own rows always; friends' rows when not private
create policy "items_select_own_or_friend_public"
    on public.items
    for select
    to authenticated
    using (
        user_id = (select auth.uid())
        or (
            is_private = false
            and public.is_friend_of_auth(user_id)
        )
    );

-- INSERT/UPDATE/DELETE: own rows only
create policy "items_insert_own"
    on public.items
    for insert
    to authenticated
    with check (user_id = (select auth.uid()));

create policy "items_update_own"
    on public.items
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

create policy "items_delete_own"
    on public.items
    for delete
    to authenticated
    using (user_id = (select auth.uid()));
