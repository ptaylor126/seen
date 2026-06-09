-- Denormalise TMDB metadata onto items so the library render touches zero
-- TMDB calls (today: N+1 per row, ~700 proxy calls per library open) and
-- can server-side filter / sort by genre.
--
-- All five columns nullable, no defaults. The backfill is a separate
-- step run after this migration, and is re-runnable on rows where title
-- is null. Forward-stamping at the three insert sites
-- (title detail + onboarding currently-watching + onboarding best-watched)
-- ships in a follow-up PR so the backfill doesn't have to chase a moving
-- target.
--
-- genre_ids gets a GIN index because the user-facing feature is
-- "filter watched by genre" — overlap (genre_ids && ARRAY[28, 12])
-- needs the index to stay fast at library scale. The other four
-- columns are display-only; no indexes until a query actually
-- wants one (a future language filter would warrant btree on
-- original_language, for example).
--
-- No RLS change. The new columns aren't visibility-relevant — they
-- mirror TMDB's public data. The existing items_select_own_or_friend_public
-- / items_insert_own / items_update_own / items_delete_own policies
-- already cover the read/write surface and don't reference these columns.

alter table public.items
    add column title text,
    add column poster_path text,
    add column release_date date,
    add column original_language text,
    add column genre_ids integer[];

create index items_genre_ids_gin_idx
    on public.items using gin (genre_ids);
