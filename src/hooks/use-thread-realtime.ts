import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

import supabase from '@/lib/supabase';

// Per-screen realtime for a thread (chat or rec): subscribe to this thread's
// rows while the screen is FOCUSED, fire `onEvent` on every INSERT/UPDATE/
// DELETE, tear down on blur/unmount. The caller's onEvent is expected to be
// its silent load() — we refetch rather than merge payloads, reusing the
// screen's tested reconciliation path (same event → refresh() pattern as
// use-unread-count).
//
// Lifetime is focus-scoped (useFocusEffect, not mount): a screen pushed-over
// (e.g. title page over the chat) unsubscribes, and its focus reload on
// return covers the blur window. postgres_changes has NO replay — events
// missed while backgrounded/disconnected are gone — so the screens'
// AppState-'active' and focus reloads remain the reconciliation layer; this
// hook only makes the open, focused screen live.
//
// Security note: the eq filters are efficiency, not the boundary — the
// realtime server checks each event against the subscriber's SELECT policies
// (the block-aware party policies), so non-parties receive nothing.
//
// Channel mechanics mirror use-unread-count: a random per-subscribe topic
// suffix so a Strict Mode double-mount / Fast Refresh can never hand a
// JOINED channel back to a fresh effect (adding bindings post-subscribe
// throws), and removeChannel in the cleanup tears the old one down
// independently.
export function useThreadRealtime({
    topic,
    bindings,
    onEvent,
    enabled = true,
}: {
    // Stable per-thread topic base, e.g. `chat:${chatId}` — a random suffix
    // is appended per subscribe.
    topic: string;
    // postgres_changes bindings, e.g.
    // [{ table: 'chat_comments', filter: `chat_id=eq.${chatId}` }].
    // May be recreated inline each render — resubscription is keyed on the
    // serialized value, not the array identity.
    bindings: Array<{ table: string; filter: string }>;
    // Called on every event. Held in a ref, so a new function identity per
    // render never forces a resubscribe and events always reach the latest.
    onEvent: () => void;
    // False skips subscribing entirely (e.g. an invalid route param).
    enabled?: boolean;
}): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const bindingsRef = useRef(bindings);
    bindingsRef.current = bindings;

    // Value-keyed dep: inline binding arrays change identity every render;
    // only a real change (different thread id) should resubscribe.
    const bindingsKey = JSON.stringify(bindings);

    useFocusEffect(
        useCallback(() => {
            if (!enabled || bindingsRef.current.length === 0) return;

            // CHANNEL-PER-BINDING — permanent design, do NOT consolidate
            // bindings onto one shared channel. Two postgres_changes
            // bindings sharing an identical filter string on one channel
            // silently drop the SECOND binding's events (device-confirmed
            // 2026-07-10, realtime-js 2.106.0: the rec screen's comments
            // binding delivered while its reactions binding — same
            // `recommendation_id=eq.X` filter — never did; both tables
            // delivered fine on dedicated channels). One channel per table
            // binding costs one extra join per open screen — nothing next to
            // silently-dead events.
            const suffix = Math.random().toString(36).slice(2, 10);
            const channels = bindingsRef.current.map((b) => {
                const channel = supabase
                    .channel(`${topic}:${b.table}:${suffix}`)
                    .on(
                        'postgres_changes',
                        {
                            event: '*',
                            schema: 'public',
                            table: b.table,
                            filter: b.filter,
                        },
                        () => {
                            onEventRef.current();
                        },
                    );
                channel.subscribe();
                return channel;
            });

            return () => {
                for (const channel of channels) {
                    void supabase.removeChannel(channel);
                }
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps -- bindings
            // participate via bindingsKey (value identity, not reference).
        }, [topic, bindingsKey, enabled]),
    );
}
