/**
 * LaunchSequence — the animated startup screen that takes over from the native
 * splash with no visible seam.
 *
 * Frame 1 renders the FULL logo at the same size/position as the static splash
 * (expo-splash-screen: logo.png, imageWidth 240, contain, #0B0D26, centred in
 * the full window). PLATFORM ASYMMETRY as of the vc7 branch: that continuity
 * holds on iOS, where the native splash draws the same wordmark. ANDROID has
 * NO splash image — Android 12+ masks the splash icon to a circle, which
 * cropped the wordmark, so the native splash is flat navy and the wordmark
 * ARRIVES with frame 1 instead of being already on screen. The background
 * colour matches on both, so there is no colour jump either way; only iOS
 * gets mark-to-mark continuity. The logo looks around briefly, then morphs
 * (wordmark fades/drops, eyes converge) into the eyes loader, which loops
 * until the app is ready — then the whole overlay fades out to reveal the
 * destination.
 *
 * Dismissal is ready-gated, not timed: it waits for BOTH the intro morph to
 * finish AND `ready` (from the launch-ready signal in _layout). A safety
 * timeout force-dismisses so a missed ready signal can't strand the user on an
 * infinite loader.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

import { AnimatedLogo } from '@/components/animated-logo';
import { paletteV2 } from '@/theme/theme';

// MUST match app.json expo-splash-screen config for a seamless handoff.
// MUST equal app.json's expo-splash-screen backgroundColor EXACTLY (both
// platform blocks are #0B0D26 = paletteV2.bg as of the vc7 branch) — any
// drift shows as a seam at the native→JS splash handoff. The old cream
// era carried a silent #F2E7EC-vs-#EFE7EC mismatch; the navy values are
// verified equal.
const SPLASH_BG = paletteV2.bg;
const SPLASH_LOGO_WIDTH = 240; // = imageWidth
const FADE_MS = 250;
// Minimum time the launch screen stays up so the eyes-loader phase is always
// seen for a beat even when the app is ready almost instantly (fast/cached
// cold start). This is a FLOOR, not the wait — dismissal is still gated on the
// real ready signal; this only prevents the sequence feeling rushed.
const MIN_LAUNCH_MS = 2600;
// Force-dismiss guard against a missed ready signal (non-negotiable per spec).
const SAFETY_TIMEOUT_MS = 8000;

interface LaunchSequenceProps {
    /** True once the destination screen's data has settled. */
    ready: boolean;
    /** Called after the fade-out completes — parent unmounts the overlay. */
    onDone: () => void;
}

export function LaunchSequence({ ready, onDone }: LaunchSequenceProps) {
    const [introComplete, setIntroComplete] = useState(false);
    const [minElapsed, setMinElapsed] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    const dismissed = useRef(false);
    const opacity = useSharedValue(1);

    // Stable so AnimatedLogo's launch effect doesn't re-run (restart the morph).
    const handleIntroDone = useCallback(() => setIntroComplete(true), []);

    useEffect(() => {
        const min = setTimeout(() => setMinElapsed(true), MIN_LAUNCH_MS);
        const safety = setTimeout(() => setTimedOut(true), SAFETY_TIMEOUT_MS);
        return () => {
            clearTimeout(min);
            clearTimeout(safety);
        };
    }, []);

    // Dismiss when the morph has finished, the app is ready, AND the minimum
    // on-screen time has elapsed — or when the safety timeout fires. Fade out,
    // then hand control to the parent.
    const shouldDismiss =
        (ready && introComplete && minElapsed) || timedOut;
    useEffect(() => {
        if (!shouldDismiss || dismissed.current) return;
        dismissed.current = true;
        opacity.value = withTiming(
            0,
            { duration: FADE_MS, easing: Easing.in(Easing.quad) },
            (finished) => {
                if (finished) runOnJS(onDone)();
            },
        );
    }, [shouldDismiss, opacity, onDone]);

    const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

    return (
        <Animated.View style={[styles.overlay, fadeStyle]}>
            <AnimatedLogo
                launch
                width={SPLASH_LOGO_WIDTH}
                onIntroDone={handleIntroDone}
            />
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    overlay: {
        // Full window (NOT safe-area inset) + centred, to match the native
        // splash's full-window contain/centre exactly.
        ...StyleSheet.absoluteFillObject,
        backgroundColor: SPLASH_BG,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
