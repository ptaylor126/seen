-- RECORD ONLY — applied by hand in the Supabase SQL editor on 2026-07-13.
-- This file mirrors the live database so the repo matches; do NOT re-run
-- (the columns, constraints, and indexes already exist).
--
-- Episode-scoped private chats: extends title_chats so a chat can be about a
-- specific TV episode (you + one friend), reusing the existing thread stack —
-- no new tables. Two nullable columns (season, episode); both null = a
-- whole-show chat (today's behaviour), both set = an episode chat.
--
-- The trap this migration exists to avoid: the old single unique index
--   title_chats_pair_title_unique (least, greatest, tmdb_id, media_type)
-- guaranteed one chat per unordered pair per title. Simply adding season +
-- episode to it would BREAK the whole-show case, because NULLs are distinct in
-- a Postgres unique index — two whole-show chats for the same pair + title
-- would both be permitted. Instead we drop it and replace it with TWO PARTIAL
-- unique indexes: one for whole-show rows (where season is null) and one for
-- episode rows (where season is not null). Existing rows all have season null
-- (ADD COLUMN is nullable/no-default), so they land in the whole-show partial
-- keyed identically to the old index — nothing breaks.
--
-- Wrapped in BEGIN...COMMIT so the index swap is atomic: no window where
-- uniqueness is unenforced, and if a stray duplicate ever existed the CREATE
-- would fail and roll the whole thing back. Value + pairing checks mirror the
-- items_progress_*_check pattern (season >= 0 for TMDB "Specials", episode
-- >= 1, both-null-or-both-set).

begin;

-- (1) Episode-scope columns.
alter table public.title_chats
    add column if not exists season  integer,
    add column if not exists episode integer;

-- (2) Value + pairing checks — mirrors items_progress_*_check.
alter table public.title_chats
    add constraint title_chats_season_check
        check (season is null or season >= 0),
    add constraint title_chats_episode_check
        check (episode is null or episode >= 1),
    add constraint title_chats_episode_pairing_check
        check ((season is null) = (episode is null));

-- (3) Replace the single pair-title unique with two partial uniques.
drop index if exists public.title_chats_pair_title_unique;

-- Whole-show chats: one per unordered pair per title (season IS NULL).
create unique index title_chats_pair_title_whole_unique
    on public.title_chats (
        least(from_user_id, to_user_id),
        greatest(from_user_id, to_user_id),
        tmdb_id,
        media_type
    )
    where season is null;

-- Episode chats: one per unordered pair per (title, season, episode).
create unique index title_chats_pair_title_episode_unique
    on public.title_chats (
        least(from_user_id, to_user_id),
        greatest(from_user_id, to_user_id),
        tmdb_id,
        media_type,
        season,
        episode
    )
    where season is not null;

commit;

-- (4) Reload PostgREST's schema cache so season/episode are writable via the
--     API immediately (a signal, so it runs after COMMIT, not inside the txn).
notify pgrst, 'reload schema';
