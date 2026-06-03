import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import supabase from '@/lib/supabase';

/**
 * Inbox-badge count = (unread notifications) + (pending friend requests).
 *
 * The two sources represent different kinds of "stuff that needs me":
 *   - notifications: events to *see* (rec_received, rec_watched,
 *     friend_accepted). Inbox focus marks them read; badge drops.
 *   - friend_requests: events to *act on*. The row exists iff the
 *     request is pending — accept/decline both delete it. Opening the
 *     inbox doesn't change anything; the badge only drops when the
 *     user accepts or declines.
 *
 * No double-counting risk: the friend_request notification kind was
 * dropped in 20260603120000_drop_friend_request_notification_trigger,
 * so the friend_requests table is now the sole source of truth for
 * pending requests.
 *
 * Two refresh paths feed `count`:
 *   1. `useFocusEffect` — refetches on tab/screen focus so a quick
 *      backgrounding round-trip can't leave a stale count.
 *   2. Realtime subscription — both tables are members of the
 *      supabase_realtime publication (added by the same migration).
 *      Any INSERT / UPDATE / DELETE matching the user filter triggers
 *      a re-fetch, so new arrivals and accept/decline-driven drops
 *      land without waiting for focus. We refetch the whole count
 *      rather than maintain a delta because two sources need summing
 *      and RLS-gated deliveries can drop events on auth edges; a full
 *      re-count is cheaper than chasing those bugs.
 */
export function useUnreadCount(): { count: number; refresh: () => Promise<void> } {
    const [count, setCount] = useState(0);

    const refresh = useCallback(async () => {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) {
                setCount(0);
                return;
            }

            const [notificationsRes, friendRequestsRes] = await Promise.all([
                supabase
                    .from('notifications')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', userId)
                    .is('read_at', null),
                supabase
                    .from('friend_requests')
                    .select('id', { count: 'exact', head: true })
                    .eq('to_user_id', userId),
            ]);
            if (notificationsRes.error) throw notificationsRes.error;
            if (friendRequestsRes.error) throw friendRequestsRes.error;

            setCount(
                (notificationsRes.count ?? 0) + (friendRequestsRes.count ?? 0),
            );
        } catch (err) {
            console.error('unread count fetch failed:', err);
            // Don't surface to UI — a stale badge is better than a crash.
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            refresh();
        }, [refresh]),
    );

    // Realtime: subscribe to both tables filtered to this user, refetch
    // the count on any change. The session lookup is async, so we set
    // up the channel inside an IIFE and guard with `active` against the
    // hook unmounting before the auth round trip finishes.
    useEffect(() => {
        let active = true;
        let channel: ReturnType<typeof supabase.channel> | null = null;
        (async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId || !active) return;

            channel = supabase
                .channel(`unread:${userId}`)
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'notifications',
                        filter: `user_id=eq.${userId}`,
                    },
                    () => {
                        void refresh();
                    },
                )
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'friend_requests',
                        filter: `to_user_id=eq.${userId}`,
                    },
                    () => {
                        void refresh();
                    },
                )
                .subscribe();
        })();
        return () => {
            active = false;
            if (channel) void supabase.removeChannel(channel);
        };
    }, [refresh]);

    return { count, refresh };
}
