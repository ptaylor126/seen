import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import supabase from '@/lib/supabase';

/**
 * Inbox-badge count — a single call to the `public.unread_count` RPC, which is
 * the ONE definition of the composite, shared by this bell and the push-payload
 * app-icon badge (migration 20260702120000_create_unread_count_rpc). The RPC
 * returns, for the calling user:
 *     (unread notifications, excluding rec_received)
 *   + (pending friend requests — friend_requests rows to me)
 *   + (pending recs to me, status='pending', NOT already in my library).
 *
 * The arithmetic lives server-side ON PURPOSE — that's what guarantees the bell
 * and the icon badge can never drift. Do NOT reintroduce a client-side
 * composition here; change the definition in the SQL function instead. The RPC
 * is SECURITY DEFINER with an own-user guard, so we pass our own uid.
 *
 * This hook's remaining job is purely WHEN to refetch. Two refresh paths feed
 * `count`:
 *   1. `useFocusEffect` — refetches on tab/screen focus so a quick
 *      backgrounding round-trip can't leave a stale count.
 *   2. Realtime subscription — notifications + friend_requests (via
 *      20260603120000), recommendations (via 20260620130000), and items
 *      (via 20260703120000) are publication members. Any INSERT / UPDATE /
 *      DELETE matching the user filter triggers a re-fetch, so new recs,
 *      reads, accept/decline/dismiss drops, AND add-to-library actions land
 *      live. We refetch the whole count rather than maintain a delta because
 *      the sources need summing server-side and RLS-gated deliveries can
 *      drop events on auth edges; a full re-count is cheaper than chasing
 *      those bugs.
 *
 *      The items subscription exists because adding a recommended title to
 *      the library is what removes that rec from the count (the RPC's
 *      NOT EXISTS items check) — without it, the bell lagged until the next
 *      tab focus and the APP-ICON BADGE until the next app foreground (the
 *      AppState refresh fires on 'active', not on backgrounding), leaving
 *      the icon a full session stale for add-actioned recs. Caveat: items
 *      DELETE events may not match the user_id filter under the default
 *      replica identity (PK-only), but the delete path that affects the
 *      count (un-watch) also flips the linked rec back to 'pending' via the
 *      reopen trigger, which signals through the recommendations
 *      subscription.
 */
export function useUnreadCount(): {
    count: number;
    loaded: boolean;
    refresh: () => Promise<void>;
} {
    const [count, setCount] = useState(0);
    // False until the first refresh actually resolves a value. Consumers that
    // drive the OS app-icon badge gate on this so they never write the initial
    // placeholder 0 before the real count lands (which would flash the badge to
    // 0 and back on launch). Stays false on a fetch error, so a failed first
    // load can't clobber a badge the push payload already set.
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) {
                setCount(0);
                setLoaded(true); // signed out is a determined state → 0 is real
                return;
            }

            // One round-trip to the canonical composite. Same definition the
            // push-payload icon badge reads server-side, so bell == badge.
            const { data, error } = await supabase.rpc('unread_count', {
                p_uid: userId,
            });
            if (error) throw error;
            setCount(typeof data === 'number' ? data : 0);
            setLoaded(true);
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
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'recommendations',
                        filter: `to_user_id=eq.${userId}`,
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
                        table: 'items',
                        filter: `user_id=eq.${userId}`,
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

    return { count, loaded, refresh };
}
