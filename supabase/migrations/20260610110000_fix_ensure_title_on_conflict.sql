-- ensure_title: fix the silent ON CONFLICT failure that has prevented
-- forward-path title stamping from EVER succeeding since stage 3
-- shipped (commit f49c728, 2026-06-09).
--
-- Symptom: every client call to ensure_title from the items insert
-- sites errored with 42P10 "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification". The error was
-- silently swallowed by the fire-and-forget `void` wrapper at the
-- call site, so the user just saw "Unable to load title" in the
-- library for every title added after the 2026-06-09 backfill (the
-- backfill was the only source of titles rows). Verified by tracing
-- in Metro on 2026-06-10.
--
-- Root cause: the function declared `#variable_conflict use_variable`
-- so parameter names that match titles column names (tmdb_id,
-- media_type, …) bind to the function parameters in the INSERT's
-- VALUES clause. plpgsql applies that binding to EVERY identifier in
-- every SQL statement in the function — including the ON CONFLICT
-- (col_list) target, which is supposed to be a syntactic column-name
-- reference for constraint inference. plpgsql substituted the
-- parameter placeholders before PG's main parser saw the statement,
-- so `ON CONFLICT (tmdb_id, media_type)` was effectively
-- `ON CONFLICT ($1, $2)` — and no constraint matches that, hence
-- 42P10 even though titles_pkey IS `PRIMARY KEY (tmdb_id, media_type)`
-- and would have matched a literal column-name reference.
--
-- Fix: change `ON CONFLICT (tmdb_id, media_type) DO NOTHING` →
-- `ON CONFLICT ON CONSTRAINT titles_pkey DO NOTHING`. Constraint
-- names aren't subject to plpgsql parameter substitution, so this
-- references the PK unambiguously. Single-line behaviour fix; the
-- function's contract (7 args by name, INSERT-or-no-op semantics,
-- SECURITY DEFINER, search_path locked, EXECUTE granted to
-- authenticated) is otherwise identical. Client code in
-- src/lib/titles.ts requires NO change.
--
-- Alternative considered: rename all parameters to p_* and drop the
-- use_variable directive. Rejected — much larger surface (client +
-- typegen + migration coordinated), no functional advantage over
-- the constraint-name reference.
--
-- Coupling to the constraint name: if `titles_pkey` is ever renamed
-- or replaced with a differently-named unique constraint on the
-- same columns, this function must be updated to match. The PK on
-- a system catalogue table is unlikely to be renamed, but flagging
-- the dependency here so a future migration touching titles knows
-- to look.
--
-- CREATE OR REPLACE preserves the existing function's EXECUTE grants
-- (the GRANT EXECUTE TO authenticated from 20260609130000); no
-- re-grant needed.

create or replace function public.ensure_title(
    tmdb_id integer,
    media_type text,
    title text,
    poster_path text,
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
        release_date,
        original_language,
        genre_ids
    ) values (
        tmdb_id,
        media_type,
        title,
        poster_path,
        release_date,
        original_language,
        genre_ids
    )
    on conflict on constraint titles_pkey do nothing;
end;
$$;
