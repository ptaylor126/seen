-- public.titles — shared catalogue table mirroring the slice of TMDB
-- metadata the app actually reads. One row per (tmdb_id, media_type);
-- every items row in every user's library points at the same titles
-- row via its existing (tmdb_id, media_type) pair, so the same movie
-- isn't denormalised onto N items rows the way the previous approach
-- did.
--
-- Five columns mirror the data shape settled on in stage 1:
--   - title              text          (display name)
--   - poster_path        text          (raw TMDB path with leading slash,
--                                      no CDN base — keeps the shape
--                                      consistent with TMDB responses)
--   - release_date       date          (release / first air; null when
--                                      TMDB returns an empty string)
--   - original_language  text          (ISO 639-1, 2 chars)
--   - genre_ids          integer[]     (TMDB genre ids)
--
-- genre_ids gets a GIN index for "filter library by genre"
-- (`genre_ids && ARRAY[28, 12]`) once that UI ships. The other four
-- columns are display-only; no indexes until a query needs one.
--
-- updated_at + the generic set_updated_at trigger (declared in
-- 20260518123418_create_items.sql) so re-stamps from a future
-- "refresh from TMDB" path bump the column.
--
-- RLS (see comment block above the policy):
--   - SELECT to authenticated. Public catalogue data; nothing to gate.
--   - No INSERT/UPDATE/DELETE policy. Backfill runs as service role
--     and bypasses RLS. Forward-path stamping at the three items insert
--     sites will be addressed in a follow-up PR when we touch them.

create table public.titles (
    tmdb_id integer not null,
    media_type text not null,
    title text,
    poster_path text,
    release_date date,
    original_language text,
    genre_ids integer[],
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint titles_pkey primary key (tmdb_id, media_type),
    constraint titles_media_type_check
        check (media_type in ('movie', 'tv'))
);

create index titles_genre_ids_gin_idx
    on public.titles using gin (genre_ids);

create trigger titles_set_updated_at
    before update on public.titles
    for each row execute function public.set_updated_at();

alter table public.titles enable row level security;

-- SELECT: any authenticated user can read any title row. No visibility
-- gate — this table holds the same TMDB-sourced data we'd otherwise
-- fetch from the public TMDB API. Anon stays denied because the app
-- is auth-only and there's no reason to widen the surface.
create policy "titles_select_authenticated"
    on public.titles
    for select
    to authenticated
    using (true);

-- No INSERT / UPDATE / DELETE policies. With RLS enabled and no
-- matching policy, those operations are denied for client roles by
-- default. Service role bypasses RLS for the backfill.
