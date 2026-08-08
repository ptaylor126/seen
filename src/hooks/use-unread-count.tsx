import { useFocusEffect } from 'expo-router';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { emitNotificationChange } from '@/lib/notification-signal';
import supabase from '@/lib/supabase';

/**
 * Inbox-badge count — a single call to the `public.unread_count` RPC, which is
 * the ONE definition of the composite, shared by the bell and the push-payload
 * app-icon badge (migration 20260702120000_create_unread_count_rpc). The RPC
 * returns, for the calling user:
 *     (unread notifications, excluding rec_received)
 *   + (pending friend requests — friend_requests rows to me)
 *   + (pending recs to me, status='pending', NOT already in my library).
 *
 * The arithmetic lives server-side ON PURPOSE — that's what guarantees the bell
 * and the icon badge can never drift on DEFINITION. Do NOT reintroduce a
 * client-side composition here; change the SQL function instead.
 *
 * Client-side there is ONE shared count instance (UnreadCountProvider, mounted
 * at the root of (tabs)): one state, one realtime channel, one RPC per event.
 * Every bell and the OS icon-badge sync read the SAME state, so they can't
 * diverge on VALUE either. This replaced five independent useUnreadCount
 * instances (four tab screens + the tabs layout), where the layout's copy —
 * the one driving the icon badge — could go stale while the tab copies
 * updated: bell dropped, icon stayed pinned.
 *
 * WHEN the shared count refetches:
 *   1. Screen focus — registered by CONSUMING SCREENS via useUnreadCount()
 *      (each screen's own navigation context), NOT by the provider:
 *      useFocusEffect in a layout component binds to the whole (tabs) route,
 *      which keeps focus across tab switches — exactly the trigger that
 *      proved unreliable for the old layout instance. Screens' focus events
 *      demonstrably fire; the provider contributes no focus trigger of its
 *      own (just a mount-time initial fetch).
 *   2. Realtime — notifications + friend_requests (via 20260603120000),
 *      recommendations (via 20260620130000), and items (via 20260703120000)
 *      are publication members; any event matching the user filter refetches.
 *      The items subscription is what makes add-to-library actions land live
 *      (adding a recommended title is what removes that rec from the count).
 *      Items DELETE events may not match the filter under PK-only replica
 *      identity, but the delete path that affects the count (un-watch) also
 *      reopens the rec via trigger, signalling through recommendations.
 *   3. AppState 'active' — foreground fallback for missed deliveries while
 *      backgrounded.
 *
 * We refetch the whole count rather than maintain a delta because the sources
 * need summing server-side and RLS-gated deliveries can drop events on auth
 * edges; a full re-count is cheaper than chasing those bugs.
 */

interface UnreadCountState {
    count: number;
    // False until the first refresh actually resolves a value. The icon-badge
    // sync gates on this so it never writes the initial placeholder 0 before
    // the real count lands (which would flash the badge to 0 and back on
    // launch). Stays false on a fetch error, so a failed first load can't
    // clobber a badge the push payload already set.
    loaded: boolean;
    refresh: () => Promise<void>;
}

const UnreadCountContext = createContext<UnreadCountState | null>(null);

// The single count owner. Mount ONCE, at the root of (tabs) — everything
// under it consumes via useUnreadCount() / useUnreadCountValue().
export function UnreadCountProvider({ children }: { children: ReactNode }) {
    const [count, setCount] = useState(0);
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) {
                // NO setCount(0) and NO setLoaded(true) here: getSession()
                // transiently returns null on cold start (session restore)
                // and during token refreshes. `loaded` must mean "a real
                // count was fetched" — declaring it on this path with the
                // initial count=0 made IconBadgeSync write a spurious 0
                // (and, worse, ended the session with zero further
                // correction attempts). The auth listener below re-runs
                // refresh the moment the session lands; a genuinely
                // signed-out user's badge hygiene is cleanupPushOnSignOut's
                // job, and the provider unmounts as routing leaves (tabs).
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

    // Initial fetch on mount. The provider deliberately has NO
    // useFocusEffect (see header comment); consuming screens provide the
    // ongoing focus refetches, this covers the cold start before any screen
    // focus lands.
    useEffect(() => {
        void refresh();
    }, [refresh]);

    // App-foreground fallback: focus effects only fire on navigation. They
    // do NOT fire when the OS brings the app back from background with the
    // same screen still mounted. If realtime was disconnected during
    // background or a network blip dropped a delivery, the count would stay
    // stale until the user navigated. Refetching on AppState 'active'
    // transitions closes that gap.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                void refresh();
            }
        });
        return () => sub.remove();
    }, [refresh]);

    // Realtime: ONE channel, four table subscriptions filtered to this user;
    // refetch the count on any change. The session lookup is async, so we
    // set up the channel inside an IIFE and guard with `active` against the
    // provider unmounting before the auth round trip finishes.
    //
    // Channel naming: `supabase.channel(name)` returns the existing channel
    // if one is already registered under that topic. Combined with
    // `removeChannel()`'s async teardown (sends a `phx_leave` and only
    // removes from the realtime registry after the server acks), a React
    // Strict Mode double-mount or a Fast Refresh hot-reload can get the new
    // effect run a still-subscribed channel back — and calling `.on(...)` on
    // a JOINED channel throws "cannot add postgres_changes callbacks ...
    // after subscribe()". Per-effect random suffix sidesteps the reuse path
    // entirely; each mount gets its own fresh channel under a unique topic,
    // the previous one tears down independently in the background.
    useEffect(() => {
        let active = true;
        let channel: ReturnType<typeof supabase.channel> | null = null;

        // Channel creation, callable from BOTH the immediate attempt and the
        // auth listener. The old shape was a one-shot getSession(): on a
        // push-tap cold start that call transiently returns null (session
        // still restoring), the early-return left the WHOLE session with no
        // realtime channel and no retry — the badge-staleness hole. The auth
        // listener's INITIAL_SESSION/SIGNED_IN/TOKEN_REFRESHED events now
        // (re)try setup + refresh as soon as a session actually exists.
        const setupChannel = (userId: string) => {
            if (!active || channel) return;

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
                    (payload) => {
                        // Count path — unchanged: recount on any event.
                        void refresh();
                        // List path — publish to the module signal so the inbox
                        // (a root route, OUTSIDE this provider's (tabs) subtree,
                        // so it can't read our context) reloads off this SAME
                        // channel. Not a second channel; a fan-out of the one we
                        // already have. ONLY the notifications binding fans out
                        // — the list changes only when notifications changes.
                        const newRow = payload.new as {
                            read_at?: string | null;
                            payload?: Record<string, unknown>;
                        };
                        const oldRow = payload.old as {
                            payload?: Record<string, unknown>;
                        };
                        emitNotificationChange({
                            eventType: payload.eventType,
                            newReadAt: newRow?.read_at ?? null,
                            oldPayload: oldRow?.payload ?? null,
                            newPayload: newRow?.payload ?? null,
                        });
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

            channel = newChannel;
        };

        (async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (userId && active) setupChannel(userId);
        })();

        const { data: authSub } = supabase.auth.onAuthStateChange(
            (_event, session) => {
                const userId = session?.user.id;
                if (!userId || !active) return;
                setupChannel(userId);
                // Also (re)fetch the count: the mount-time refresh may have
                // hit the transient-null window and fetched nothing.
                void refresh();
            },
        );

        return () => {
            active = false;
            authSub.subscription.unsubscribe();
            if (channel) void supabase.removeChannel(channel);
        };
    }, [refresh]);

    return (
        <UnreadCountContext.Provider value={{ count, loaded, refresh }}>
            {children}
        </UnreadCountContext.Provider>
    );
}

function useUnreadCountContext(): UnreadCountState {
    const ctx = useContext(UnreadCountContext);
    if (!ctx) {
        throw new Error(
            'useUnreadCount must be used under UnreadCountProvider ((tabs)/_layout mounts it)',
        );
    }
    return ctx;
}

// Screen-consumer hook. Same name + return shape as the old five-instance
// hook, so the tab screens' one-liner call sites are unchanged — but it now
// reads the SHARED provider state and contributes the screen's own
// focus-refetch trigger (running in the SCREEN's navigation context, which is
// what keeps tab-switch and pop-back refreshes working — see header comment).
export function useUnreadCount(): UnreadCountState {
    const ctx = useUnreadCountContext();
    const { refresh } = ctx;
    useFocusEffect(
        useCallback(() => {
            void refresh();
        }, [refresh]),
    );
    return ctx;
}

// Value-only consumer for non-screen contexts (the icon-badge sync in the
// tabs layout): reads the shared state WITHOUT registering a focus effect —
// layout-level focus binds to the whole (tabs) route and is exactly the
// trigger that proved unreliable; the badge must not depend on it.
export function useUnreadCountValue(): UnreadCountState {
    return useUnreadCountContext();
}
