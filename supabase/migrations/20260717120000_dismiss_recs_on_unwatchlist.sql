-- Dismiss a recommendation when its recipient removes the linked title from
-- their library WITHOUT having watched it (watchlist / watching → removed).
--
-- RECORD-ONLY: applied by hand in the Supabase SQL editor; this file is the
-- record. Do NOT re-apply. Wrapped in begin/commit so a hand-run is atomic;
-- the verification queries at the foot run AFTER commit.
--
-- Background: Save on the rec screen upserts an items row and deliberately
-- leaves the rec at status='pending' (nothing anywhere writes 'accepted' —
-- a dormant-but-legal CHECK value). When the recipient later removes that
-- title from their watchlist (title screen toggleOff → items DELETE), the
-- rec dangled: still 'pending', pointing at a title they'd chosen to drop.
--
-- Fix: the mirror of reopen_recs_on_unwatch (20260619120000), resolving the
-- OTHER direction. An AFTER DELETE trigger on items that, when a row leaves
-- the library from 'watchlist' or 'watching', resolves the matching open
-- recommendation(s) to 'dismissed' — "not for me", silently.
--
-- DECISIONS (locked before writing):
--   * Gate on old.status IN ('watchlist','watching') — "saved, maybe
--     started, then removed" all resolve. Not watchlist-only (a
--     watchlist→watching→removed path would otherwise escape).
--   * Target recs at status IN ('pending','accepted') — 'accepted' is
--     dormant but legal, covered defensively.
--   * Reverses ALL matches for the identity triple, every sender —
--     removing the title means "not for me" regardless of who sent it,
--     consistent with the season-blind precedent (20260714150000).
--   * NO dismiss_reason is set. notify_recommendation_declined fires only
--     on a null→non-null dismiss_reason (20260620120000), so this is
--     SILENT — no sender notification. resolved_at stamps automatically
--     via set_recommendation_resolved_at on entering 'dismissed'.
--   * Self-added items with a later unsolicited rec ALSO auto-dismiss on
--     removal (no accepted_via_rec flag exists to tell the cases apart —
--     accepted trade-off; the "Changed my mind" un-decline path is the
--     recovery valve, returning the rec to 'pending').
--   * DB trigger, NOT a client fix in toggleOff: onboarding-utils.ts is a
--     second items-DELETE site, and any future delete site is covered
--     automatically. Client fixes miss by construction.
--
-- DISJOINTNESS with the un-watch mirror (stated for the record): the
-- existing items_reopen_recs_on_unwatch_delete gates old.status='watched';
-- this trigger gates old.status IN ('watchlist','watching'). A row has
-- exactly one status at delete time, so exactly one of the two can fire —
-- the predicates partition the space and un-watch behaviour is untouched.
-- There is deliberately NO companion UPDATE trigger here (the un-watch
-- mirror needed one for watched→watchlist/watching transitions): status
-- moves among the three library values never LEAVE the library, so
-- "removed from watchlist" only ever manifests as a DELETE.
--
-- NO BACKFILL, deliberately: a pre-trigger dangler (saved, then removed)
-- is indistinguishable in the data from a brand-new rec never acted on —
-- both are 'pending' with no items row; the delete left no tombstone. The
-- 20260619 backfill could scope safely because its items rows still
-- existed; ours don't, by definition. Any sweep would dismiss every
-- untouched rec in every inbox. Pre-existing danglers resolve the next
-- time the recipient acts on the rec.
--
-- Trigger-chain effects of the dismiss UPDATE, checked:
--   * enforce_recommendation_immutability — ALLOWS status changes.
--   * set_recommendation_resolved_at — stamps resolved_at (wanted).
--   * notify_recommendation_watched — fires only ENTERING 'watched'; no.
--   * notify_recommendation_declined — needs non-null dismiss_reason; no.
--   * rating_thumb: pending/accepted rows are null by CHECK
--     (recommendations_rating_thumb_only_when_watched_check), so no reset
--     needed (the un-watch mirror resets it because it leaves 'watched').
--
-- SECURITY DEFINER + pinned search_path, matching reopen_recs_on_unwatch:
-- the resolve is a data invariant that must run regardless of the caller's
-- RLS. The recommendations updated are scoped to the deleted items row's
-- own user_id, and items RLS already guarantees a user only deletes their
-- own rows, so the recipient match is exactly the acting user.

begin;

create or replace function public.dismiss_recs_on_unwatchlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.recommendations
    set status = 'dismissed'
    where to_user_id = old.user_id
      and tmdb_id = old.tmdb_id
      and media_type = old.media_type
      and status in ('pending', 'accepted');
    return null;
end;
$$;

-- Fires only when an UNWATCHED library row is deleted — the watched case
-- belongs to items_reopen_recs_on_unwatch_delete (old.status='watched'),
-- which reopens instead of dismissing. Predicates are disjoint.
create trigger items_dismiss_recs_on_unwatchlist_delete
    after delete on public.items
    for each row
    when (old.status in ('watchlist', 'watching'))
    execute function public.dismiss_recs_on_unwatchlist();

commit;

-- ============================================================================
-- POST-APPLY VERIFICATION — run each AFTER commit, compare to expectation.
-- Direct catalog queries, not the editor's "Success".
-- ============================================================================

-- Function exists with the expected body (status filter + dismissed):
--     select pg_get_functiondef(
--         'public.dismiss_recs_on_unwatchlist()'::regprocedure);
-- Expect: the UPDATE ... set status = 'dismissed' ... status in
-- ('pending', 'accepted') body above, SECURITY DEFINER, search_path=public.

-- BOTH delete triggers present on items, with DISJOINT WHEN clauses:
--     select tgname, pg_get_triggerdef(oid)
--     from pg_trigger
--     where tgrelid = 'public.items'::regclass
--       and tgname in ('items_reopen_recs_on_unwatch_delete',
--                      'items_dismiss_recs_on_unwatchlist_delete')
--     order by tgname;
-- Expect 2 rows:
--   items_dismiss_recs_on_unwatchlist_delete
--       ... AFTER DELETE ... WHEN ((old.status = ANY (ARRAY['watchlist'::text,
--       'watching'::text]))) EXECUTE ... dismiss_recs_on_unwatchlist()
--   items_reopen_recs_on_unwatch_delete
--       ... AFTER DELETE ... WHEN ((old.status = 'watched'::text))
--       EXECUTE ... reopen_recs_on_unwatch()

-- Behavioural smoke (two accounts, in the app):
--   1. A recommends title T to B. B Saves → Watchlist (rec stays pending,
--      badge shows). B removes T from the library on the title screen.
--      Expect: the rec flips to 'dismissed' (greyed "Passed" in B's inbox
--      history), resolved_at set, NO rec_declined notification row for A:
--          select status, dismiss_reason, resolved_at
--          from recommendations where id = '<rec-id>';
--          select count(*) from notifications
--          where kind = 'rec_declined'
--            and payload->>'recommendation_id' = '<rec-id>';   -- expect 0
--   2. Un-watch regression check: B watches T' (rec advances to watched),
--      then removes T' from the library. Expect the rec REOPENS to
--      'pending' (the old trigger, untouched), NOT dismissed.
--   3. Recovery valve: on the auto-dismissed rec, B taps "Changed my mind"
--      → back to 'pending'.

-- Context only (NOT a backfill candidate — see header): the number of
-- pending recs whose recipient has no items row for the title. This UNION
-- of genuine danglers and never-acted recs cannot be split; do not sweep.
--     select count(*)
--     from recommendations r
--     where r.status = 'pending'
--       and not exists (
--           select 1 from items i
--           where i.user_id = r.to_user_id
--             and i.tmdb_id = r.tmdb_id
--             and i.media_type = r.media_type
--       );
