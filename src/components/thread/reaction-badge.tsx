import { MotiView } from 'moti';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { type ReactionRow } from '@/components/thread/shared';
import { getPalette, radius } from '@/theme/theme';

// Fixed width per emoji in the reaction badge — generous enough that any
// emoji's drawn bitmap (which iOS can render wider than its measured
// advance) fits with room to centre. See the emoji style for why the Text
// must not self-size.
export const EMOJI_CELL_WIDTH = 18;

// The corner reaction badge — a small surface pill of joined emojis that
// overlaps its anchor's top corner (message bubbles, the rec card).
// Extracted verbatim from comment-list.tsx so every thread surface renders
// the identical badge. This component owns the pill's VISUAL (fill, border,
// padding, emoji metrics, mount pop, stacking) and the shared top overhang;
// the caller positions it horizontally via `style` (e.g. the bubbles'
// inner-corner left/right offsets, the rec card's top-right corner).
export function ReactionBadge({
    reactions,
    palette,
    style,
}: {
    reactions: ReactionRow[];
    palette: ReturnType<typeof getPalette>;
    style?: StyleProp<ViewStyle>;
}) {
    if (reactions.length === 0) return null;
    return (
        <MotiView
            from={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{
                type: 'spring',
                damping: 11,
                stiffness: 260,
            }}
            style={[
                styles.badge,
                {
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                },
                style,
            ]}
        >
            <Text
                style={[
                    styles.emoji,
                    { width: reactions.length * EMOJI_CELL_WIDTH },
                ]}
            >
                {reactions.map((r) => r.emoji).join('')}
            </Text>
        </MotiView>
    );
}

const styles = StyleSheet.create({
    badge: {
        // Pure overlay: absolute, floats half-on/half-off its anchor's top
        // corner — never reserves layout space, so a reacted anchor has the
        // same vertical footprint as a plain one. top: -3 keeps clear
        // daylight from whatever sits above even in a clustered 6px bubble
        // gap (-10 climbed into the previous bubble; -6 still crowded it).
        position: 'absolute',
        top: -3,
        // The badge must paint OVER its anchor in full — a device pass
        // caught the bubble fill biting a corner off the badge. zIndex +
        // elevation pin it to the top of the stacking order on both
        // platforms.
        zIndex: 1,
        elevation: 1,
        borderRadius: radius.full,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    // Small emoji text metrics on iOS are unreliable: the measured advance
    // differs from the drawn bitmap width, and the mismatch VARIES BY
    // EMOJI (a self-sized Text clipped the ❤️'s right edge; letterSpacing/
    // margin compensation centred one emoji and skewed another). So the
    // Text doesn't self-size at all: it gets a fixed EMOJI_CELL_WIDTH per
    // emoji (inline, from the reaction count) and textAlign centres the
    // glyph run inside it — per-emoji metric quirks land as symmetric
    // slack instead of a lopsided/clipped edge.
    emoji: {
        fontSize: 12,
        lineHeight: 16,
        textAlign: 'center',
    },
});
