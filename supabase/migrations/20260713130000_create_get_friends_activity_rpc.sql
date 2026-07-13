-- RECORD ONLY — applied by hand in the Supabase SQL editor on 2026-07-13.
-- This file mirrors the live database so the repo matches; do NOT re-run
-- (the index and function already exist).
--
-- Per-friend latest activity for the friends page. get_friends_activity()
-- returns exactly one row per friend who has friend-visible, title-resolvable
-- activity: that friend's single most recent items row (by updated_at), joined
-- to titles. Friends with no qualifying activity are absent from the result.
--
-- SECURITY INVOKER (not definer): runs as the caller, so the existing RLS
-- policies remain the single source of truth for privacy —
-- items_select_own_or_friend_visible (friends' visibility='friends' rows),
-- friendships own-side SELECT (deriving the friend list), and
-- titles_select_authenticated (the join). The explicit visibility='friends'
-- filter is belt-and-braces on top of that RLS.
--
-- Fall-through: INNER JOIN titles + title IS NOT NULL means a friend whose
-- newest item isn't yet resolvable in titles shows their next resolvable
-- activity rather than dropping out. Same single DISTINCT ON sort either way.
--
-- Index: no existing index covered (user_id, updated_at) — items had
-- (user_id), (user_id, status), (tmdb_id, media_type, status), and the unique
-- (user_id, tmdb_id, media_type). This one lets the DISTINCT ON scan each
-- friend's rows already ordered by recency.

-- (1) Supporting index.
create index if not exists items_user_updated_at_idx
    on public.items (user_id, updated_at desc);

-- (2) The RPC.
create or replace function public.get_friends_activity()
returns table (
    friend_id    uuid,
    tmdb_id      integer,
    media_type   text,
    status       text,
    rating       smallint,
    title_name   text,
    activity_at  timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
    select distinct on (i.user_id)
        i.user_id            as friend_id,
        i.tmdb_id            as tmdb_id,
        i.media_type         as media_type,
        i.status             as status,
        i.rating::smallint   as rating,
        t.title              as title_name,
        i.updated_at         as activity_at
    from public.items i
    join public.titles t
        on t.tmdb_id = i.tmdb_id
       and t.media_type = i.media_type
    where i.visibility = 'friends'         -- belt-and-braces on top of RLS
      and t.title is not null              -- fall-through: only resolvable titles
      and i.user_id in (
            select case
                       when f.user_a_id = (select auth.uid()) then f.user_b_id
                       else f.user_a_id
                   end
            from public.friendships f
            where f.user_a_id = (select auth.uid())
               or f.user_b_id = (select auth.uid())
          )
    order by i.user_id, i.updated_at desc, i.tmdb_id;  -- tmdb_id = deterministic tiebreak
$$;

-- (3) Callable by the app.
grant execute on function public.get_friends_activity() to authenticated;
