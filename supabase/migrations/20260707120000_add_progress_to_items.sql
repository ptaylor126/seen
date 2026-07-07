-- Episode-progress tracking for TV library items (v1). Two nullable integer
-- columns on public.items:
--   progress_season  — the season the user is on
--   progress_episode — the episode within that season
-- Both null = not tracked yet. The app writes these only while a TV item's
-- status is 'watching'; when status moves to 'watched' the progress is RETAINED
-- (the write path simply stops touching these columns), and the in-app control
-- is hidden. Movies never use them.
--
-- Constraints: season >= 0 (TMDB "Specials" are season 0), episode >= 1, and a
-- pairing check so the two columns are always both-null or both-set.
--
-- The existing own-row RLS UPDATE policy (with check user_id = auth.uid()) and
-- the table-level UPDATE grant to `authenticated` already cover these new
-- columns — no policy or grant change is needed.
--
-- ============================================================================
-- APPLY MANUALLY — do NOT `supabase db push`.
-- This project's migration history is out of sync with the remote, so a push is
-- not safe. Paste this file into the Supabase SQL editor and run it. The final
-- statement (notify pgrst, 'reload schema';) tells PostgREST to reload its
-- schema cache so the API accepts the new columns — without it, the app's
-- writes to progress_season/progress_episode fail with "column not found".
-- ============================================================================

alter table public.items
    add column if not exists progress_season  integer,
    add column if not exists progress_episode integer;

alter table public.items
    add constraint items_progress_season_check
        check (progress_season is null or progress_season >= 0),
    add constraint items_progress_episode_check
        check (progress_episode is null or progress_episode >= 1),
    add constraint items_progress_pairing_check
        check ((progress_season is null) = (progress_episode is null));

-- REQUIRED: reload PostgREST's schema cache so the new columns are writable
-- through the API immediately.
notify pgrst, 'reload schema';
