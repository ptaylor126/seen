-- Add backdrop_path to public.titles, and widen ensure_title to stamp
-- it on the forward-path catalogue write.
--
-- TMDB detail and search responses already include backdrop_path —
-- typed on TMDBMovie / TMDBTV / TMDBMovieSummary / TMDBTVSummary in
-- src/lib/tmdb.ts but discarded by every consumer until now. Adding
-- the column + plumbing lets the upcoming wide-cinematic home rec
-- hero card render the landscape image as the backdrop instead of
-- the small 2:3 poster.
--
-- nullable: not every TMDB title has a backdrop (festival / unreleased
-- / niche entries are typically NULL — TMDB's coverage is ~95% on
-- mainstream movies, ~85% on TV, lower on indie/foreign). Renderer
-- handles the NULL minority with a fallback (solid surfaceAlt with
-- the title overlaid). Existing ~842 rows get filled in by
-- scripts/backfill-titles-backdrop.mjs after this migration applies.

alter table public.titles
    add column backdrop_path text;

-- ensure_title widens from 7 to 8 params (adds backdrop_path between
-- poster_path and release_date — image-path columns grouped together
-- in the signature for readability; RPC callers use named args so
-- positional order has no client-visible effect).
--
-- DROP the 7-arg version explicitly BEFORE CREATE: PG overloads by
-- signature, so without the DROP both versions would coexist and a
-- client passing only the original 7 args could still resolve to the
-- stale function. The DROP + CREATE pair runs inside the migration
-- transaction (Supabase CLI's `db push` wraps migrations in a txn),
-- so callers never see an in-between state where the function
-- doesn't exist.
--
-- The #variable_conflict use_variable directive and the
-- ON CONFLICT ON CONSTRAINT titles_pkey clause both stay — same
-- reasoning as 20260610110000_fix_ensure_title_on_conflict:
-- parameter names matching column names are bound by `use_variable`
-- into the VALUES expressions (correct), and ON CONFLICT (col_list)
-- would mis-substitute those same names into the conflict-target
-- column list (the bug that migration fixed by referencing the
-- constraint by name instead). The new param `backdrop_path`
-- follows the same convention as the existing 7 — same-name-as-
-- column, bound via use_variable into the VALUES list.

drop function if exists public.ensure_title(
    integer, text, text, text, date, text, integer[]
);

create function public.ensure_title(
    tmdb_id integer,
    media_type text,
    title text,
    poster_path text,
    backdrop_path text,
    release_date date,
    original_language text,
    genre_ids integer[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
    me uuid := (select auth.uid());
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    if media_type not in ('movie', 'tv') then
        raise exception 'invalid media_type';
    end if;

    insert into public.titles (
        tmdb_id,
        media_type,
        title,
        poster_path,
        backdrop_path,
        release_date,
        original_language,
        genre_ids
    ) values (
        tmdb_id,
        media_type,
        title,
        poster_path,
        backdrop_path,
        release_date,
        original_language,
        genre_ids
    )
    on conflict on constraint titles_pkey do nothing;
end;
$$;

-- Re-grant EXECUTE — DROP removes all grants from the old signature,
-- and the new 8-arg signature is a NEW function from PG's perspective
-- (not the same one being replaced via CREATE OR REPLACE). Mirrors
-- the EXECUTE grant pattern from the original ensure_title creation
-- (20260609130000) and the fix migration (20260610110000).
grant execute on function public.ensure_title(
    integer, text, text, text, text, date, text, integer[]
) to authenticated;
