import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

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

    // App-foreground fallback: useFocusEffect only fires on navigation
    // (tab switch, screen push). It does NOT fire when the OS brings the
    // app back from background to foreground with the same screen still
    // mounted. If realtime was disconnected during background or a
    // network blip dropped a delivery, the badge would stay stale until
    // the user navigated. Refetching on AppState 'active' transitions
    // closes that gap.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                void refresh();
            }
        });
        return () => sub.remove();
    }, [refresh]);

    // Realtime: subscribe to both tables filtered to this user, refetch
    // the count on any change. The session lookup is async, so we set
    // up the channel inside an IIFE and guard with `active` against the
    // hook unmounting before the auth round trip finishes.
    //
    // Channel naming: `supabase.channel(name)` returns the existing
    // channel if one is already registered under that topic. Combined
    // with `removeChannel()`'s async teardown (sends a `phx_leave` and
    // only removes from the realtime registry after the server acks),
    // a React Strict Mode double-mount or a Fast Refresh hot-reload can
    // get the new effect run a still-subscribed channel back — and
    // calling `.on(...)` on a JOINED channel throws "cannot add
    // postgres_changes callbacks ... after subscribe()". Per-effect
    // random suffix sidesteps the reuse path entirely; each mount gets
    // its own fresh channel under a unique topic, the previous one
    // tears down independently in the background.
    useEffect(() => {
        let active = true;
        let channel: ReturnType<typeof supabase.channel> | null = null;
        (async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId || !active) return;

            const topic = `unread:${userId}:${Math.random().toString(36).slice(2, 10)}`;
            const newChannel = supabase
                .channel(topic)
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

            if (!active) {
                // Cleanup raced subscribe() — `channel` was never assigned,
                // so the cleanup return won't tear this one down. Do it
                // here directly rather than orphan it on the realtime client.
                void supabase.removeChannel(newChannel);
                return;
            }
            channel = newChannel;
        })();
        return () => {
            active = false;
            if (channel) void supabase.removeChannel(channel);
        };
    }, [refresh]);

    return { count, refresh };
}
