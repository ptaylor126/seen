/**
 * Ambient toast — the app's ONE snackbar mechanism.
 *
 * Extracted verbatim from profile/edit's local "Saved" toast the moment
 * a second consumer appeared (the title page's visibility toggle); the
 * original screen-local implementation carried a comment scoping it
 * local "because there's no other consumer" — that condition ended, so
 * the pattern moved here rather than being forked.
 *
 * Shape: a pill pinned above the bottom safe-area inset, optional
 * leading icon + body text, Reanimated fade in/out, single timer;
 * re-triggering while visible swaps the message and resets the timer.
 * pointerEvents="none" so it can never block taps beneath it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/text';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

const TOAST_VISIBLE_MS = 1500;
const TOAST_FADE_MS = 150;

export function useToast(): {
    /** Show `message` (optionally with a small leading icon) for ~1.5s. */
    showToast: (message: string, icon?: ReactNode) => void;
    /** Render this once, last in the screen's root view. */
    toast: ReactNode;
} {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState<{
        message: string;
        icon?: ReactNode;
    } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((message: string, icon?: ReactNode) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setContent({ message, icon });
        timerRef.current = setTimeout(() => {
            setContent(null);
            timerRef.current = null;
        }, TOAST_VISIBLE_MS);
    }, []);

    // Cancel a pending hide on unmount so a fast back-navigation
    // mid-toast doesn't fire a setState against an unmounted screen.
    useEffect(() => {
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, []);

    const toast = content ? (
        <Animated.View
            entering={FadeIn.duration(TOAST_FADE_MS)}
            exiting={FadeOut.duration(TOAST_FADE_MS)}
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            style={[
                styles.toast,
                {
                    bottom: insets.bottom + spacing.xl,
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                },
            ]}
        >
            {content.icon ?? null}
            <Text style={[typography.body, { color: palette.text }]}>
                {content.message}
            </Text>
        </Animated.View>
    ) : null;

    return { showToast, toast };
}

const styles = StyleSheet.create({
    toast: {
        // Pill pinned above the bottom inset; `bottom` set inline from
        // useSafeAreaInsets so it clears the home indicator without a
        // magic offset.
        position: 'absolute',
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
        borderRadius: radius.full,
        borderWidth: 1,
    },
});
