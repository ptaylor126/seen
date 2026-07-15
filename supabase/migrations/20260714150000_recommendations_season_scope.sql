-- Season-scoped recommendations — a recommendation can carry an optional
-- SEASON coordinate (whole-show when null). A season rec is a SUGGESTION with
-- a coordinate, NOT a tracked entity: it lands in the inbox and is
-- dismissed/actioned exactly like a whole-show rec, and it creates NO
-- season-level watched state or ratings. Watched tracking stays title-level
-- and high-water-mark.
--
-- RECORD-ONLY: applied by hand in the Supabase SQL editor; this file is the
-- record. Do NOT re-apply. Wrapped in begin/commit so a hand-run is atomic;
-- the verification queries at the foot run AFTER commit.
--
-- Mirrors the title_chats episode-scope work (20260713140000): a nullable
-- coordinate + partial unique indexes so one whole-show rec PLUS N season
-- recs can coexist per (pair, title). DIFFERENCE: recommendations are
-- DIRECTIONAL, so the indexes keep raw (from_user_id, to_user_id) —
-- title_chats used least/greatest because a chat is one conversation
-- regardless of who started it; a rec has a fixed sender→recipient direction.
--
-- DECISIONS MADE EXPLICIT (flag before applying if any feel wrong):
--   * Multiple open season recs for one show MAY coexist (S1 + S4 both
--     pending). Marking the TITLE watched resolves ALL of them together,
--     because watched-tracking is title-level and marking a title watched
--     means you watched the show. applyWatchedRating (src/lib/rating.ts) and
--     the reopen_recs_on_unwatch trigger (20260619120000) stay SEASON-BLIND
--     on purpose — they match on (to_user_id/user_id, tmdb_id, media_type)
--     only. This migration deliberately does NOT touch them. Per-season
--     matching would require season-level watched state, which we are
--     deliberately not building. (In-code comments on both say the same, so
--     nobody "fixes" the asymmetry.)
--   * items, the watched/rating lifecycle, and the overlap machinery are
--     UNTOUCHED. A season coordinate is display-only metadata on the rec and
--     is dropped when the rec becomes a title-level items row (items has no
--     season column; unique on (user_id, tmdb_id, media_type)).
--   * season is SENDER-SET and IMMUTABLE after send (added to the
--     immutability trigger in §3).
--   * A season number is NOT a spoiler the way an episode title is, so the
--     push names it plainly ("recommended Season N of {title}") — no
--     suppression. That copy lives in the send-push-notification edge
--     function (deployed separately); this migration only puts `season` into
--     the rec_received payload so the push can read it.

begin;

-- ============================================================================
-- (1) recommendations.season + value CHECK (mirrors title_chats_season_check)
-- ============================================================================

alter table public.recommendations
    add column season integer,
    add constraint recommendations_season_check
        check (season is null or season >= 0);

-- ============================================================================
-- (2) Pair-uniqueness → two partial unique indexes.
--
-- recommendations_pair_unique is a table CONSTRAINT over
-- (from_user_id, to_user_id, tmdb_id, media_type). Drop it and replace with
-- two partial unique indexes so season IS NULL rows can't be duplicated:
-- a single b-tree over the 4 cols + season would treat NULL season as
-- distinct and wrongly allow duplicate whole-show recs. Existing rows all
-- have season IS NULL and land in the whole-show partial (IDENTICAL key to
-- the old constraint), so nothing breaks and no backfill is needed.
-- ============================================================================

alter table public.recommendations
    drop constraint recommendations_pair_unique;

-- Whole-show: one rec per (sender, recipient, title) when season is null.
create unique index recommendations_pair_whole_unique
    on public.recommendations (from_user_id, to_user_id, tmdb_id, media_type)
    where season is null;

-- Season: one rec per (sender, recipient, title, season) when season is set.
create unique index recommendations_pair_season_unique
    on public.recommendations
        (from_user_id, to_user_id, tmdb_id, media_type, season)
    where season is not null;

-- ============================================================================
-- (3) enforce_recommendation_immutability — lock `season` too.
--
-- LIVE OBJECT — verify before running. Fetch the CURRENT live definition:
--     select pg_get_functiondef(
--         'public.enforce_recommendation_immutability()'::regprocedure);
-- The body below is the live one (from 20260518130612) with one added block
-- locking `season`. If the live body has drifted, reconcile before running.
-- ============================================================================

create or replace function public.enforce_recommendation_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    is_privileged boolean := current_user not in ('authenticated', 'anon');
begin
    if new.id is distinct from old.id then
        raise exception 'cannot change id of a recommendation';
    end if;
    if new.from_user_id is distinct from old.from_user_id then
        if not (is_privileged
                and old.from_user_id is not null
                and new.from_user_id is null) then
            raise exception 'cannot change from_user_id of a recommendation';
        end if;
    end if;
    if new.to_user_id is distinct from old.to_user_id then
        raise exception 'cannot change to_user_id of a recommendation';
    end if;
    if new.tmdb_id is distinct from old.tmdb_id then
        raise exception 'cannot change tmdb_id of a recommendation';
    end if;
    if new.media_type is distinct from old.media_type then
        raise exception 'cannot change media_type of a recommendation';
    end if;
    -- season is a sender-set coordinate — immutable after send, like tmdb_id
    -- / media_type. (Lifecycle updates never touch it, so this never fires on
    -- a status/rating change.)
    if new.season is distinct from old.season then
        raise exception 'cannot change season of a recommendation';
    end if;
    if new.note is distinct from old.note then
        raise exception 'cannot change note of a recommendation';
    end if;
    if new.sent_at is distinct from old.sent_at then
        raise exception 'cannot change sent_at of a recommendation';
    end if;
    return new;
end;
$$;

-- ============================================================================
-- (4) send_recommendation — add a nullable `season` param, write it, and put
-- it in the rec_received notification payload so the push can name it.
--
-- The signature CHANGES (4 → 5 args). A create-or-replace would LEAVE the
-- 4-arg overload in place and make the client's named-arg call ambiguous
-- ("function is not unique"), so drop the old overload first. Re-grant after.
--
-- LIVE OBJECT — verify the current body before running:
--     select pg_get_functiondef(
--         'public.send_recommendation(uuid, integer, text, text)'::regprocedure);
-- ============================================================================

drop function if exists public.send_recommendation(uuid, integer, text, text);

create or replace function public.send_recommendation(
    to_user_id uuid,
    tmdb_id integer,
    media_type text,
    note text default null,
    season integer default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
    me uuid := (select auth.uid());
    new_id uuid;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    if to_user_id is null or to_user_id = me then
        raise exception 'invalid recipient';
    end if;
    if media_type not in ('movie', 'tv') then
        raise exception 'invalid media_type';
    end if;
    if season is not null and season < 0 then
        raise exception 'invalid season';
    end if;
    if note is not null and char_length(note) > 500 then
        raise exception 'note too long';
    end if;
    if not public.is_friend_of_auth(to_user_id) then
        raise exception 'recipient is not a friend';
    end if;

    insert into public.recommendations
        (from_user_id, to_user_id, tmdb_id, media_type, note, season)
    values (me, to_user_id, tmdb_id, media_type, note, season)
    returning id into new_id;

    insert into public.notifications (user_id, kind, payload)
    values (
        to_user_id,
        'rec_received',
        jsonb_build_object(
            'from_user_id', me,
            'recommendation_id', new_id,
            'tmdb_id', tmdb_id,
            'media_type', media_type,
            'season', season
        )
    );

    return new_id;
end;
$$;

grant execute
    on function public.send_recommendation(uuid, integer, text, text, integer)
    to authenticated;

-- ============================================================================
-- (5) pending_recommendations.season (invite path) + insert grant.
--
-- So a season rec survives an invite-then-join: the sender stamps `season`
-- on the pending row, and claim (§6) threads it into the real rec. Adds the
-- value CHECK and widens the column-level INSERT grant (currently
-- from_user_id, tmdb_id, media_type, note) to include season.
-- ============================================================================

alter table public.pending_recommendations
    add column season integer,
    add constraint pending_recommendations_season_check
        check (season is null or season >= 0);

grant insert (season) on public.pending_recommendations to authenticated;

-- ============================================================================
-- (6) claim_pending_recommendation — thread `season` into the real rec.
--
-- LIVE OBJECT — verify the current body before running:
--     select pg_get_functiondef(
--         'public.claim_pending_recommendation(text)'::regprocedure);
-- Body below is the live one (from 20260712120000) with season threaded into
-- the rec insert. The old single `on conflict (from_user_id, to_user_id,
-- tmdb_id, media_type) do nothing` can no longer infer an arbiter — that
-- column set is now covered by TWO partial indexes — so the insert branches
-- on season to name the matching partial, preserving the original
-- DO NOTHING + re-select race handling. Signature is unchanged, so the
-- existing execute grant carries over.
-- ============================================================================

create or replace function public.claim_pending_recommendation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    pending record;
    a uuid;
    b uuid;
    rec_id uuid;
    rec_existed boolean := false;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;

    if p_token is null or p_token = '' then
        raise exception 'invalid token';
    end if;

    select * into pending
    from public.pending_recommendations
    where token = p_token
    for update;

    if not found then
        raise exception 'recommendation not found';
    end if;

    if pending.claimed_at is not null then
        raise exception 'recommendation already claimed';
    end if;

    if pending.from_user_id = me then
        raise exception 'cannot claim your own recommendation';
    end if;

    if public.is_blocked_pair(me, pending.from_user_id) then
        raise exception 'recommendation not available';
    end if;

    a := least(me, pending.from_user_id);
    b := greatest(me, pending.from_user_id);

    delete from public.friend_requests
    where (from_user_id = me and to_user_id = pending.from_user_id)
       or (from_user_id = pending.from_user_id and to_user_id = me);

    insert into public.friendships (user_a_id, user_b_id)
    values (a, b)
    on conflict (user_a_id, user_b_id) do nothing;

    -- The real recommendation, sender → claimer, carrying the pending row's
    -- season. Branch on season so the ON CONFLICT names the matching partial
    -- unique index (a single arbiter can't span both). If the identical rec
    -- already exists (sender re-recommended the same (title, season) through
    -- the normal flow between send and claim), reuse it: the claim still
    -- succeeds, returns a routable id, and skips the sender notification.
    if pending.season is null then
        insert into public.recommendations
            (from_user_id, to_user_id, tmdb_id, media_type, note, season)
        values
            (pending.from_user_id, me, pending.tmdb_id, pending.media_type,
             pending.note, null)
        on conflict (from_user_id, to_user_id, tmdb_id, media_type)
            where season is null
        do nothing
        returning id into rec_id;
    else
        insert into public.recommendations
            (from_user_id, to_user_id, tmdb_id, media_type, note, season)
        values
            (pending.from_user_id, me, pending.tmdb_id, pending.media_type,
             pending.note, pending.season)
        on conflict (from_user_id, to_user_id, tmdb_id, media_type, season)
            where season is not null
        do nothing
        returning id into rec_id;
    end if;

    if rec_id is null then
        rec_existed := true;
        -- `is not distinct from` keeps the season match NULL-safe: a
        -- whole-show pending reuses a whole-show rec, a season pending reuses
        -- the same-season rec.
        select id into rec_id
        from public.recommendations
        where from_user_id = pending.from_user_id
          and to_user_id = me
          and tmdb_id = pending.tmdb_id
          and media_type = pending.media_type
          and season is not distinct from pending.season;
        if rec_id is null then
            raise exception 'recommendation not available';
        end if;
    end if;

    update public.pending_recommendations
    set claimed_by = me,
        claimed_at = now()
    where id = pending.id;

    if not rec_existed then
        insert into public.notifications (user_id, kind, payload)
        values (
            pending.from_user_id,
            'rec_claimed',
            jsonb_build_object(
                'from_user_id', me,
                'claimed_by', me,
                'recommendation_id', rec_id,
                'pending_recommendation_id', pending.id,
                'tmdb_id', pending.tmdb_id,
                'media_type', pending.media_type,
                'season', pending.season
            )
        );
    end if;

    return rec_id;
end;
$$;

commit;

-- ============================================================================
-- (7) POST-APPLY VERIFICATION — run each AFTER commit, compare to expectation.
-- Direct catalog queries, not the editor's "Success".
-- ============================================================================

-- season column exists, nullable, with its CHECK:
--     select column_name, data_type, is_nullable
--     from information_schema.columns
--     where table_schema = 'public' and table_name = 'recommendations'
--       and column_name = 'season';
-- Expect: season | integer | YES
--     select pg_get_constraintdef(oid)
--     from pg_constraint
--     where conname = 'recommendations_season_check'
--       and conrelid = 'public.recommendations'::regclass;
-- Expect: CHECK ((season IS NULL) OR (season >= 0))

-- Old constraint GONE, two partial unique indexes PRESENT:
--     select conname from pg_constraint
--     where conname = 'recommendations_pair_unique'
--       and conrelid = 'public.recommendations'::regclass;
-- Expect: 0 rows.
--     select indexname, indexdef
--     from pg_indexes
--     where schemaname = 'public' and tablename = 'recommendations'
--       and indexname in ('recommendations_pair_whole_unique',
--                         'recommendations_pair_season_unique')
--     order by indexname;
-- Expect 2 rows; the whole one WHERE (season IS NULL), the season one over
-- (..., season) WHERE (season IS NOT NULL), both UNIQUE.

-- Immutability trigger fn locks season (grep the body):
--     select pg_get_functiondef(
--         'public.enforce_recommendation_immutability()'::regprocedure)
--         ilike '%cannot change season%';
-- Expect: true.

-- send_recommendation is the 5-arg version, 4-arg gone, grant present:
--     select to_regprocedure(
--         'public.send_recommendation(uuid, integer, text, text, integer)'),
--            to_regprocedure(
--         'public.send_recommendation(uuid, integer, text, text)');
-- Expect: 5-arg not null; 4-arg NULL.
--     select has_function_privilege('authenticated',
--         'public.send_recommendation(uuid, integer, text, text, integer)',
--         'execute');
-- Expect: true.

-- send_recommendation writes season into the payload (grep the body):
--     select pg_get_functiondef(
--         'public.send_recommendation(uuid, integer, text, text, integer)'::regprocedure)
--         ilike '%''season'', season%';
-- Expect: true.

-- pending_recommendations.season + CHECK + column INSERT grant:
--     select column_name, is_nullable from information_schema.columns
--     where table_schema = 'public'
--       and table_name = 'pending_recommendations' and column_name = 'season';
-- Expect: season | YES
--     select column_name from information_schema.role_column_grants
--     where table_schema = 'public'
--       and table_name = 'pending_recommendations'
--       and grantee = 'authenticated' and privilege_type = 'INSERT'
--     order by column_name;
-- Expect exactly: from_user_id, media_type, note, season, tmdb_id
-- (still NOT id/token/created_at/claimed_by/claimed_at).

-- claim RPC threads season (grep the body):
--     select pg_get_functiondef(
--         'public.claim_pending_recommendation(text)'::regprocedure)
--         ilike '%pending.season%';
-- Expect: true.

-- Smoke (optional, in a real session): send a whole-show rec and a season
-- rec for the SAME title to the SAME friend; both should insert (distinct
-- partials). A second whole-show rec for that pair/title should 23505; a
-- second S1 rec should 23505; an S2 rec should insert.
