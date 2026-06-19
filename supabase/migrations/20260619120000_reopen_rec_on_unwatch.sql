-- Reopen a recommendation when its recipient un-watches the linked title.
--
-- Background: `applyWatchedRating` (src/lib/rating.ts) advances any open
-- recommendation (pending|accepted) for a title to status='watched' +
-- watched_via_rec=true when the recipient marks that title watched. That
-- sync was one-directional: when the recipient later moved the library
-- item OFF 'watched' (-> watchlist / watching) or removed it entirely, the
-- recommendation stayed 'watched' and so vanished permanently from the
-- inbox (the Received list shows status='pending' only), with no way to
-- recover it.
--
-- Fix: an AFTER UPDATE/DELETE trigger on items that, whenever a row LEAVES
-- 'watched', reopens the matching recommendation(s) back to 'pending'.
-- Symmetric with the set path:
--   - matches on (to_user_id = items.user_id, tmdb_id, media_type) -- the
--     same triple applyWatchedRating uses;
--   - reverses ALL matches (a title can be rec'd by several friends);
--   - only touches recs we auto-advanced (watched_via_rec = true);
--   - resets status='pending', watched_via_rec=false, rating_thumb=null
--     (rating_thumb MUST be null off 'watched' per
--     recommendations_rating_thumb_only_when_watched_check; resolved_at is
--     cleared automatically by set_recommendation_resolved_at).
--
-- "Any exit from watched reopens" -- watched->watchlist, watched->watching,
-- and watched->removed all reopen. Restoring to 'pending' (not 'accepted')
-- is deliberate: the inbox only surfaces 'pending', and the prior state
-- isn't stored.
--
-- SECURITY DEFINER + pinned search_path, matching the other rec triggers
-- (notify_recommendation_watched etc.): the reverse is a data invariant
-- that must run regardless of the caller's RLS. The recommendations the
-- function updates are scoped to the items row's own user_id, and items RLS
-- already guarantees a user only mutates their own items, so the recipient
-- match is exactly the acting user. The reverse UPDATE fires the existing
-- recommendations BEFORE-UPDATE triggers (immutability ALLOWS status
-- changes; set_recommendation_resolved_at nulls resolved_at) and does NOT
-- fire notify_recommendation_watched (that fires only ENTERING 'watched'),
-- so no spurious notification. Note: this does NOT retract the original
-- rec_watched notification already sent to the sender -- a known, separate
-- drift, out of scope here.

create or replace function public.reopen_recs_on_unwatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.recommendations
    set status = 'pending',
        watched_via_rec = false,
        rating_thumb = null
    where to_user_id = old.user_id
      and tmdb_id = old.tmdb_id
      and media_type = old.media_type
      and status = 'watched'
      and watched_via_rec = true;
    return null;
end;
$$;

-- Fires only on the transitions that constitute "un-watching": an items
-- row moving off 'watched', or a 'watched' row being deleted (the
-- clear-status / toggle-off path deletes the row outright).
create trigger items_reopen_recs_on_unwatch_update
    after update on public.items
    for each row
    when (old.status = 'watched' and new.status is distinct from 'watched')
    execute function public.reopen_recs_on_unwatch();

create trigger items_reopen_recs_on_unwatch_delete
    after delete on public.items
    for each row
    when (old.status = 'watched')
    execute function public.reopen_recs_on_unwatch();

-- One-time backfill: heal recs already stuck at 'watched' whose recipient
-- has since moved the title off 'watched'. SCOPED to items that STILL
-- EXIST and are not watched -- we deliberately do NOT reopen recs whose
-- item was fully deleted (that would resurrect long-finished recs into the
-- inbox). Going forward the DELETE trigger covers the removal case.
update public.recommendations r
set status = 'pending',
    watched_via_rec = false,
    rating_thumb = null
where r.status = 'watched'
  and r.watched_via_rec = true
  and exists (
      select 1
      from public.items i
      where i.user_id = r.to_user_id
        and i.tmdb_id = r.tmdb_id
        and i.media_type = r.media_type
        and i.status <> 'watched'
  );
