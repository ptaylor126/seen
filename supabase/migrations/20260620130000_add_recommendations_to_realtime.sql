-- Add public.recommendations to the supabase_realtime publication so the
-- inbox badge can drop the instant a received rec is actioned.
--
-- WHY: the badge now treats a received rec as ACTIONABLE — it counts
-- `recommendations` rows where to_user_id = me AND status = 'pending'
-- (mirroring how pending friend_requests rows are counted), and that
-- contribution must persist until the rec is actioned, not until it's
-- viewed. Saving (status -> watchlist/watching/watched/saved) or "Not for
-- me" (status -> dismissed) is an UPDATE on this table. A *new* rec already
-- bumps the badge live via the rec_received notification (notifications is
-- already a publication member), but the status-flip DROP only became live
-- once this table joined the publication. Without it the drop waited for
-- the next focus / app-foreground refetch.
--
-- Guarded so re-running is a no-op (matches 20260603120000's pattern for
-- notifications + friend_requests).
do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'recommendations'
    ) then
        alter publication supabase_realtime add table public.recommendations;
    end if;
end $$;
