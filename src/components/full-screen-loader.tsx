/**
 * Full-screen eyes loader + the timing that stops it flickering.
 *
 * Two pieces, used together:
 *
 *  - useDeferredLoading(loading) → `busy`: a drop-in replacement for the raw
 *    loading flag. It is true from the moment loading starts and STAYS true
 *    through a short minimum-visible window after loading ends (so the loader
 *    can't blink out the instant it appears). Crucially `busy` is a superset of
 *    `loading`, so a screen that renders `{busy ? <FullScreenLoader/> : content}`
 *    only ever renders `content` once the data is genuinely ready — no
 *    half-loaded flash, and the same guard works in a ternary or an early
 *    `if (busy) return`.
 *
 *  - <FullScreenLoader/>: the loader view. It self-defers — it renders a blank
 *    (but space-reserving) box for SHOW_DELAY_MS, then the eyes. On a fast load
 *    the parent stops rendering it before that elapses, so the eyes never
 *    appear at all (no flash on quick loads).
 *
 * Net effect across both: fast loads show nothing; slow loads show the eyes
 * after ~200ms and keep them up for at least ~400ms. The launch sequence is
 * deliberately NOT routed through this — it has its own MIN_LAUNCH_MS pacing
 * (see launch-sequence.tsx).
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AnimatedLogo } from '@/components/animated-logo';

const LOADER_WIDTH = 120;
// Don't reveal the eyes unless loading lasts at least this long.
const SHOW_DELAY_MS = 200;
// Once the eyes are visible, keep them up at least this long.
const MIN_VISIBLE_MS = 400;

export function useDeferredLoading(loading: boolean): boolean {
    const [busy, setBusy] = useState(loading);
    // Timestamp loading began this cycle; null while idle.
    const startedAtRef = useRef<number | null>(loading ? Date.now() : null);

    useEffect(() => {
        if (loading) {
            startedAtRef.current = Date.now();
            setBusy(true);
            return undefined;
        }

        // Loading ended. If the eyes would already be on screen, hold them for
        // the remainder of the minimum-visible window; otherwise drop instantly
        // (they never appeared, so there's nothing to flash).
        const startedAt = startedAtRef.current;
        startedAtRef.current = null;
        if (startedAt === null) {
            setBusy(false);
            return undefined;
        }
        const appearedAt = startedAt + SHOW_DELAY_MS;
        const remaining = appearedAt + MIN_VISIBLE_MS - Date.now();
        if (Date.now() < appearedAt || remaining <= 0) {
            // Never appeared, or the min window has already passed.
            setBusy(false);
            return undefined;
        }
        const t = setTimeout(() => setBusy(false), remaining);
        return () => clearTimeout(t);
    }, [loading]);

    return busy;
}

export function FullScreenLoader({ style }: { style?: StyleProp<ViewStyle> }) {
    const [showEyes, setShowEyes] = useState(false);

    useEffect(() => {
        const t = setTimeout(() => setShowEyes(true), SHOW_DELAY_MS);
        return () => clearTimeout(t);
    }, []);

    // Reserve the centred space during the defer window so there's no layout
    // jump when the eyes appear.
    return (
        <View style={[styles.center, style]}>
            {showEyes ? <AnimatedLogo eyesOnly width={LOADER_WIDTH} /> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
