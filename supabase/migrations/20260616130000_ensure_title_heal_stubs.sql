-- ensure_title: rename parameters to p_*, drop the #variable_conflict
-- use_variable directive, and switch ON CONFLICT from DO NOTHING to
-- DO UPDATE SET ... = COALESCE(excluded.x, titles.x). The forward-path
-- catalogue write now HEALS pre-existing stub rows (title /
-- poster_path / backdrop_path NULL — likely created by a TMDB hiccup
-- during the 2026-06-09 backfill, where a 200-with-non-string-fields
-- response slipped through the script's `if (!res.ok)` guard and
-- produced an INSERT with all-null content) instead of silently
-- DO-NOTHING'ing past them.
--
-- Why the parameter rename to p_*:
-- The previous version used `#variable_conflict use_variable` so
-- parameter names matching column names would bind to parameters in
-- VALUES expressions. That directive bit us on 2026-06-10 when it
-- ALSO substituted parameter placeholders into the ON CONFLICT
-- (col_list) target — fixed there by switching to
-- ON CONFLICT ON CONSTRAINT titles_pkey. The current migration adds
-- DO UPDATE SET col = ..., where the LHS column references sit in
-- the same parser position as ON CONFLICT (col_list) and would risk
-- the same substitution. There is NO constraint-name shortcut for
-- the SET LHS, so the only safe path is to eliminate the
-- parameter/column name conflict entirely — rename parameters to
-- p_* and drop the use_variable directive. Default plpgsql behaviour
-- (`use_column` = columns win for unqualified names) then does the
-- right thing everywhere: INSERT col list, ON CONFLICT, SET LHS all
-- resolve as columns; VALUES and SET RHS use p_* parameter
-- references explicitly.
--
-- Why DO UPDATE with COALESCE:
-- DO UPDATE writes the fresh TMDB metadata when a row already
-- exists, healing past stubs AND refreshing any stale data (TMDB
-- occasionally updates titles, posters, dates; we always honour the
-- latest data the client saw). COALESCE(excluded.x, titles.x) makes
-- the merge null-safe — if any future caller passes a nullable field
-- as NULL (the 4 current call sites all pass full TMDB-derived
-- metadata so this isn't a current risk, but defence-in-depth for
-- any future caller), the existing non-NULL value survives instead
-- of getting overwritten with NULL.
--
-- Tradeoff worth noting on genre_ids: COALESCE treats an empty array
-- `{}` as a present value (not NULL), so a caller passing
-- `genre_ids: []` (TMDB returned no genres) overwrites any
-- pre-existing genre list. This is correct semantic — if TMDB
-- currently says "no genres", that IS the latest known truth and
-- should win — but flagging because empty-vs-null is the kind of
-- distinction that bites later if the call surface ever expands.
--
-- DROP+CREATE (rather than CREATE OR REPLACE) is for explicitness —
-- both versions share the same arg types, so CREATE OR REPLACE would
-- preserve the function identity and keep existing grants. DROP+CREATE
-- makes the parameter rename and grant re-application visible in the
-- migration diff. Inside the migration transaction either approach is
-- atomic from callers' perspective.

drop function if exists public.ensure_title(
    integer, text, text, text, text, date, text, integer[]
);

create function public.ensure_title(
    p_tmdb_id integer,
    p_media_type text,
    p_title text,
    p_poster_path text,
    p_backdrop_path text,
    p_release_date date,
    p_original_language text,
    p_genre_ids integer[]
) returns void
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
    if p_media_type not in ('movie', 'tv') then
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
        p_tmdb_id,
        p_media_type,
        p_title,
        p_poster_path,
        p_backdrop_path,
        p_release_date,
        p_original_language,
        p_genre_ids
    )
    on conflict on constraint titles_pkey do update set
        title = coalesce(excluded.title, titles.title),
        poster_path = coalesce(excluded.poster_path, titles.poster_path),
        backdrop_path = coalesce(excluded.backdrop_path, titles.backdrop_path),
        release_date = coalesce(excluded.release_date, titles.release_date),
        original_language = coalesce(excluded.original_language, titles.original_language),
        genre_ids = coalesce(excluded.genre_ids, titles.genre_ids);
end;
$$;

-- Re-grant EXECUTE — DROP removed the previous grant. The new function
-- has the same arg types as the one DROP'd (only parameter NAMES and
-- the function BODY changed), so the GRANT signature is identical to
-- what 20260616120000 granted.
grant execute on function public.ensure_title(
    integer, text, text, text, text, date, text, integer[]
) to authenticated;
