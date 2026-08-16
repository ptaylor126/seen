import {
    X,
} from 'phosphor-react-native';
import { MotiView } from 'moti';
import { useEffect, useRef } from 'react';
import {
    PanResponder,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import type { WatcherSheetItem } from '@/components/watchers-sheet';
import {
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// How long the banner dwells before dismissing itself — a whisper, not a
// modal.
const AUTO_DISMISS_MS = 6000;
// Horizontal drag distance that counts as a swipe-dismiss.
const SWIPE_DISMISS_DX = 60;

// The overlap whisper: after adding a title to the watchlist, "{name} has
// seen this" / "{name} and N others have seen this". Tap → the caller opens
// the watcher-picker; X or a horizontal swipe dismisses; auto-dismisses
// after a dwell. Presentational — the caller owns visibility (render it
// only while watchers are set), the query, and what tapping opens.
//
// MOUNTED PER-SCREEN, never at the root: the title page is a natively
// presented fullScreenModal, and a root-mounted overlay renders invisibly
// BENEATH presented screens (the chat-nav topology lesson). Position is
// absolute at the bottom of the mounting screen; pass `style` to lift it
// above pinned bars (e.g. the rec screen's composer).
export function OverlapBanner({
    watchers,
    onPress,
    onDismiss,
    style,
}: {
    // Non-empty; the first watcher leads the copy (most-recent-first from
    // getFriendsWhoWatched).
    watchers: WatcherSheetItem[];
    onPress: () => void;
    onDismiss: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    // Auto-dismiss dwell. onDismiss is held in a ref so the timer doesn't
    // reset on parent re-renders.
    const onDismissRef = useRef(onDismiss);
    onDismissRef.current = onDismiss;
    useEffect(() => {
        const timer = setTimeout(() => {
            onDismissRef.current();
        }, AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
    }, []);

    // Horizontal swipe dismisses. Created once via useRef (the handler only
    // calls the ref'd onDismiss, so no stale-closure risk). Vertical drags
    // are ignored so the banner never captures list scrolling underneath.
    const panResponder = useRef(
        PanResponder.create({
            onMoveShouldSetPanResponder: (_e, g) =>
                Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
            onPanResponderRelease: (_e, g) => {
                if (Math.abs(g.dx) > SWIPE_DISMISS_DX) {
                    onDismissRef.current();
                }
            },
        }),
    ).current;

    const lead = watchers[0];
    if (!lead) return null;
    const second = watchers[1] ?? null;
    const leadName = lead.displayName.split(/\s+/)[0] || lead.displayName;
    const secondName = second
        ? second.displayName.split(/\s+/)[0] || second.displayName
        : null;
    // Names while they fit: one → "{name} has seen this"; two → both names;
    // three+ → "{name} and N others". ("and 1 other" is broken grammar.)
    const tail =
        watchers.length >= 3
            ? ` and ${watchers.length - 1} others have seen this`
            : secondName
              ? null // two-name form rendered inline below
              : ' has seen this';

    return (
        <MotiView
            from={{ opacity: 0, translateY: 24 }}
            animate={{ opacity: 1, translateY: 0 }}
            transition={{ type: 'timing', duration: 220 }}
            style={[styles.wrap, style]}
            {...panResponder.panHandlers}
        >
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={
                    watchers.length >= 3
                        ? `${leadName} and ${watchers.length - 1} others have seen this. Open the list.`
                        : secondName
                          ? `${leadName} and ${secondName} have seen this. Open the list.`
                          : `${leadName} has seen this. Open the list.`
                }
                style={({ pressed }) => [
                    styles.banner,
                    {
                        // The BRANDING.md notification tier: light
                        // lavender, deliberately OUTSIDE the navy family
                        // (both navy variants tried first — surface
                        // #151838, surfaceAlt #162954 — read as background
                        // on device) and deliberately NOT the accent (a
                        // toast is informational, not an action; the
                        // accent stays "act here" only). Content on it is
                        // textInverse — dark on the light surface.
                        backgroundColor: palette.notification,
                        borderColor: palette.border,
                        opacity: pressed ? 0.8 : 1,
                    },
                ]}
            >
                <Avatar
                    avatarUrl={lead.avatarUrl}
                    displayName={lead.displayName}
                    seedId={lead.userId}
                    size={28}
                />
                <Text
                    // textInverse, not text: light text would vanish on
                    // the light accent fill. The nested bodyEmphasis spans
                    // set only the face, so they inherit this colour.
                    style={[
                        typography.body,
                        styles.text,
                        { color: palette.textInverse },
                    ]}
                    numberOfLines={1}
                >
                    <Text style={typography.bodyEmphasis}>{leadName}</Text>
                    {tail ?? (
                        <>
                            {' and '}
                            <Text style={typography.bodyEmphasis}>
                                {secondName}
                            </Text>
                            {' have seen this'}
                        </>
                    )}
                </Text>
                <Pressable
                    onPress={onDismiss}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss"
                    style={({ pressed }) => [pressed && { opacity: 0.5 }]}
                >
                    <X
                        // Same dark-on-accent flip as the body text.
                        color={palette.textInverse}
                        size={16}
                    />
                </Pressable>
            </Pressable>
        </MotiView>
    );
}

const styles = StyleSheet.create({
    // Floating at the mounting screen's bottom edge, inset from the sides.
    // Callers lift it above pinned bars via the style prop.
    wrap: {
        position: 'absolute',
        left: spacing.base,
        right: spacing.base,
        bottom: spacing.lg,
    },
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        // md (was sm): the sm banner read too small to register as a
        // tappable surface next to the contrast bump.
        paddingVertical: spacing.md,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
    },
    text: {
        flex: 1,
    },
});
