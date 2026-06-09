-- ensure_title — security-definer RPC that adds a missing row to
-- public.titles, ignoring conflicts. The ONLY client-reachable write
-- path for that table.
--
-- Why this shape (not a client INSERT policy):
-- public.titles holds shared catalogue metadata. Once a row exists,
-- we don't want any client to overwrite it with potentially staler
-- data picked up at add-time on a different device or session. An
-- INSERT-only policy + ignoreDuplicates upsert from the client would
-- work, but it widens the client-write surface to "anything matching
-- the policy" — and policies on a no-user-id catalogue table can't
-- gate by ownership the way items's policies do. Routing every write
-- through a SECURITY DEFINER RPC keeps the contract narrow:
--   * The function is the only thing that writes titles. Period.
--   * It does INSERT ... ON CONFLICT DO NOTHING, so it can add but
--     never overwrite. Existing rows (backfill, prior add) are
--     immutable from any client path.
--   * No client INSERT/UPDATE/DELETE policy on titles is needed.
--     The locked-down posture from 20260609110000 stays intact.
--   * service_role still has the scoped INSERT/UPDATE for the
--     backfill and any future server-side maintenance, separate
--     surface (see 20260609120000).
--
-- Pattern follows send_recommendation (the existing client-facing
-- RPC): plpgsql, security definer, search_path locked to public,
-- #variable_conflict use_variable so arg names that match column
-- names resolve to the args inside the INSERT, explicit auth.uid()
-- null-guard, explicit EXECUTE grant to authenticated.
--
-- Arguments mirror the five data columns the title-detail and
-- onboarding insert sites already have in hand:
--   - tmdb_id, media_type are the conflict target.
--   - title / poster_path / original_language are passed as-is.
--   - release_date is `date`; the client is responsible for mapping
--     TMDB's empty-string dates to NULL before calling (matches the
--     backfill's behaviour at scripts/backfill-titles.mjs).
--   - genre_ids is integer[]; backfill and detail-screen call sites
--     have either genre_ids directly (search) or genres.map(g=>g.id)
--     (detail).

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
    on conflict (tmdb_id, media_type) do nothing;
end;
$$;

-- Postgres defaults EXECUTE on new functions to PUBLIC, but the
-- project's convention (see 20260519102336) is explicit grants for
-- every client-callable function so the API contract reads off the
-- grants migration without inferring from defaults. Mirrors the
-- pattern used by send_recommendation / accept_friend_request / etc.
grant execute on function public.ensure_title(
    integer, text, text, text, date, text, integer[]
) to authenticated;
