import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import supabase from '@/lib/supabase';

/**
 * Inbox-badge count = (informational unread notifications)
 *                    + (pending friend requests)
 *                    + (pending received recs).
 *
 * Two distinct kinds of contributor:
 *
 *   INFORMATIONAL — clears when SEEN. Notifications for events to *see*
 *   (rec_watched, rec_reacted, rec_commented, friend_accepted,
 *   rec_declined). Counted while read_at IS NULL; the inbox-focus sweep
 *   marks them read and the badge drops.
 *
 *   ACTIONABLE — clears only when the action is COMPLETED, never on view:
 *     - friend_requests: the row exists iff the request is pending;
 *       accept/decline both delete it. Opening the inbox changes nothing.
 *     - recommendations: a received rec with status='pending' AND no
 *       items row yet for its (tmdb_id, media_type). The items row — not
 *       rec.status — is the "has the user acted" signal: saving to
 *       watchlist/watching upserts an items row but leaves rec.status
 *       'pending', and a rec can arrive for a title the user already
 *       tracks (nothing to action). So we count pending recs MINUS those
 *       whose title is already in the library. "Not for me" (status ->
 *       dismissed) and watched-with-rating also drop it. Viewing the
 *       inbox changes neither status nor library, so the contribution
 *       persists until the rec is actioned — mirroring friend_requests.
 *
 * No double-counting: the friend_request notification kind was dropped in
 * 20260603120000, and we exclude the 'rec_received' kind from the
 * notifications count here (`.neq('kind','rec_received')`). A received rec
 * is counted ONCE, via the actionable pending-recs query — not also via
 * its rec_received notification (that row still drives push + the inbox
 * list, it just no longer feeds the badge, which is what stops it being
 * view-cleared). Tables are the sole source of truth for the two
 * actionable kinds.
 *
 * Two refresh paths feed `count`:
 *   1. `useFocusEffect` — refetches on tab/screen focus so a quick
 *      backgrounding round-trip can't leave a stale count.
 *   2. Realtime subscription — notifications + friend_requests (via
 *      20260603120000) and recommendations (via 20260620130000) are
 *      publication members. Any INSERT / UPDATE / DELETE matching the
 *      user filter triggers a re-fetch, so new recs, reads, and
 *      accept/decline/dismiss drops land live. We refetch the whole count
 *      rather than maintain a delta because the sources need summing
 *      (incl. the recs-minus-library set difference) and RLS-gated
 *      deliveries can drop events on auth edges; a full re-count is
 *      cheaper than chasing those bugs.
 *
 *      `items` is NOT a publication member, so a library add/remove does
 *      not push a realtime event — its effect on the count lands on the
 *      next focus / app-foreground refetch instead. That's consistent in
 *      practice: a library change is made from a screen the user then
 *      navigates away from (rec view, title screen), and useFocusEffect
 *      re-runs on the way back. (Add items to the publication + a fourth
 *      subscription here if instant library-driven updates are ever
 *      needed.)
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

            const [notificationsRes, friendRequestsRes, pendingRecsRes, libraryRes] =
                await Promise.all([
                    // Informational only: exclude rec_received — a received
                    // rec is counted as an actionable pending rec below, not
                    // here (where the inbox-view sweep would clear it).
                    supabase
                        .from('notifications')
                        .select('id', { count: 'exact', head: true })
                        .eq('user_id', userId)
                        .is('read_at', null)
                        .neq('kind', 'rec_received'),
                    supabase
                        .from('friend_requests')
                        .select('id', { count: 'exact', head: true })
                        .eq('to_user_id', userId),
                    // Actionable: received recs still awaiting a decision.
                    // We need the title keys (not a head count) so we can drop
                    // the ones that are already in the library below — there's
                    // no action to take on those. Saving a rec to
                    // watchlist/watching leaves rec.status = 'pending' (only
                    // the watched path and "Not for me" flip it), so the
                    // items row — not rec.status — is the source of truth for
                    // "has the user acted on this title".
                    supabase
                        .from('recommendations')
                        .select('tmdb_id, media_type')
                        .eq('to_user_id', userId)
                        .eq('status', 'pending'),
                    // The user's library, keyed (media_type, tmdb_id). A
                    // pending rec for a title already here isn't actionable.
                    supabase
                        .from('items')
                        .select('tmdb_id, media_type')
                        .eq('user_id', userId),
                ]);
            if (notificationsRes.error) throw notificationsRes.error;
            if (friendRequestsRes.error) throw friendRequestsRes.error;
            if (pendingRecsRes.error) throw pendingRecsRes.error;
            if (libraryRes.error) throw libraryRes.error;

            const libraryKeys = new Set(
                (libraryRes.data ?? []).map(
                    (it) => `${it.media_type}:${it.tmdb_id}`,
                ),
            );
            const actionablePendingRecs = (pendingRecsRes.data ?? []).filter(
                (r) => !libraryKeys.has(`${r.media_type}:${r.tmdb_id}`),
            ).length;

            setCount(
                (notificationsRes.count ?? 0) +
                    (friendRequestsRes.count ?? 0) +
                    actionablePendingRecs,
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
