-- Drop the friend_request notification trigger and clean up vestigial rows.
--
-- The friend_requests_notify_received trigger wrote a notifications row
-- alongside the friend_requests row whenever someone received a friend
-- request. With the inbox badge counting unread notifications, opening
-- the inbox marked that friend_request notification read — and the badge
-- dropped to zero even though the underlying friend_requests row was
-- still pending action.
--
-- Going forward, the inbox badge sums two sources:
--   - notifications WHERE read_at IS NULL  (rec_received, rec_watched,
--     friend_accepted — events the user just needs to see)
--   - friend_requests WHERE to_user_id = me  (action-required state;
--     row existence IS the pending state, deleted on accept/decline)
--
-- The friend_request notification kind is now redundant with the
-- friend_requests row itself, so the trigger goes and existing rows are
-- deleted to prevent transitional double-counting.

drop trigger if exists friend_requests_notify_received
    on public.friend_requests;

drop function if exists public.notify_friend_request_received();

-- Clean up rows the now-removed trigger had previously written. Without
-- this delete, users who'd received but not yet read a friend_request
-- notification would be counted twice — once via the unread notification
-- row, once via the still-pending friend_requests row.
delete from public.notifications where kind = 'friend_request';

-- Add the two tables to the supabase_realtime publication so the inbox
-- badge hook can subscribe to live changes (new arrivals, read_at
-- stamps, accept/decline deletions) instead of relying solely on tab
-- focus to refetch.
--
-- Guarded with pg_publication_tables lookups so the migration is safe
-- to run against environments where someone may have toggled either
-- table into the publication via the Supabase Dashboard already
-- (otherwise the bare `ALTER PUBLICATION` errors with SQLSTATE 42710).
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'notifications'
    ) then
        alter publication supabase_realtime add table public.notifications;
    end if;

    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'friend_requests'
    ) then
        alter publication supabase_realtime add table public.friend_requests;
    end if;
end $$;
