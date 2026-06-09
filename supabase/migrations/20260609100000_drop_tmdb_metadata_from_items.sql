-- Reverse 20260608130000_add_tmdb_metadata_to_items. We pivoted to a
-- shared catalogue table (public.titles, one row per
-- (tmdb_id, media_type) — created in the next migration) so the same
-- TMDB metadata isn't duplicated across every user who has the title
-- in their library.
--
-- Safe to drop: a query confirmed all 893 existing items rows have
-- null in every new column (no backfill ran, no insert sites were
-- updated to stamp them, no read paths reference them in src/).
--
-- DROP COLUMN cascades to dependent indexes, so items_genre_ids_gin_idx
-- goes away with genre_ids. The explicit DROP INDEX keeps the migration
-- log self-documenting.

drop index if exists public.items_genre_ids_gin_idx;

alter table public.items
    drop column if exists genre_ids,
    drop column if exists original_language,
    drop column if exists release_date,
    drop column if exists poster_path,
    drop column if exists title;
