import { MotiView } from 'moti';
import {
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { Text } from '@/components/text';
import {
    type PartyProfile,
    type ReactionEmoji,
    type ReactionRow,
    REACTION_EMOJIS,
} from '@/components/thread/shared';
import { UserLink } from '@/components/user-link';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// White circular reaction buttons — larger than the comment-popover
// cells (REACTION_PICKER_SIZE), spread across the full row width.
const REACTION_CELL_SIZE = 52;

// The thread-level reaction picker row — curated emoji set, one active
// selection, tap the active emoji to remove. Extracted verbatim from
// rec/[recId].tsx (where it's recipient-only; the caller owns that gate).
export function ThreadReactionPicker({
    selected,
    busy,
    onTap,
}: {
    selected: ReactionEmoji | null;
    busy: boolean;
    onTap: (emoji: ReactionEmoji) => void;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <View style={styles.reactionRow}>
            {REACTION_EMOJIS.map((emoji) => {
                const isActive = selected === emoji;
                return (
                    <Pressable
                        key={emoji}
                        onPress={() => onTap(emoji)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`React with ${emoji}`}
                        accessibilityState={{ selected: isActive }}
                        style={({ pressed }) => [
                            styles.reactionCell,
                            {
                                backgroundColor: isActive
                                    ? palette.accent
                                    : palette.surface,
                                opacity: pressed || busy ? 0.6 : 1,
                            },
                        ]}
                    >
                        {/* Pop the emoji when it becomes the
                            selected reaction. Keyed on active
                            so selecting remounts it (springs
                            from 0.6 → 1); deselecting starts
                            at 1 (no pop). Optimistic state
                            makes this fire instantly on tap. */}
                        <MotiView
                            key={isActive ? `on-${emoji}` : `off-${emoji}`}
                            from={{ scale: isActive ? 0.6 : 1 }}
                            animate={{ scale: 1 }}
                            transition={{
                                type: 'spring',
                                damping: 9,
                                stiffness: 300,
                            }}
                        >
                            <Text style={styles.reactionEmoji}>{emoji}</Text>
                        </MotiView>
                    </Pressable>
                );
            })}
        </View>
    );
}

// The other party's reaction, displayed read-only under the picker: small
// avatar + "{first name} reacted" + the emoji. Extracted verbatim from
// rec/[recId].tsx. `animate` gates the one-time soft pop on a NEW incoming
// reaction (the caller owns the last-seen marker); static otherwise.
export function ThreadIncomingReaction({
    reaction,
    profile,
    animate,
}: {
    reaction: ReactionRow;
    profile: PartyProfile | null;
    animate: boolean;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <MotiView
            // The row as a whole just FADES in (350ms, a beat
            // softer than the emoji lands). Only the emoji (the
            // payload) does the scale pop below — so the bloom is
            // centered on the glyph, not read as the whole
            // left-aligned row sliding in from one edge. Gated on
            // `animate`; static otherwise.
            from={animate ? { opacity: 0 } : { opacity: 1 }}
            animate={{ opacity: 1 }}
            transition={{ type: 'timing', duration: 350 }}
        >
            <UserLink
                userId={reaction.userId}
                hitSlop={8}
                accessibilityLabel="View profile"
                style={styles.otherReactionRow}
            >
                <Avatar
                    avatarUrl={profile?.avatarUrl ?? null}
                    displayName={profile?.displayName ?? 'Former user'}
                    seedId={profile?.userId ?? reaction.userId}
                    size={20}
                />
                <Text
                    style={[typography.caption, { color: palette.textMuted }]}
                >
                    {(profile?.displayName ?? 'Former user').split(/\s+/)[0]}{' '}
                    reacted
                </Text>
                {/* Emoji pop — its own content-sized wrapper, so the
                    transform box equals the glyph and the scale
                    blooms from its centre. 0→1 with one visible
                    overshoot (~1.15) that settles, no bounce cycles. */}
                <MotiView
                    from={animate ? { scale: 0 } : { scale: 1 }}
                    animate={{ scale: 1 }}
                    transition={{
                        type: 'spring',
                        damping: 18,
                        stiffness: 280,
                    }}
                >
                    <Text style={typography.caption}>{reaction.emoji}</Text>
                </MotiView>
            </UserLink>
        </MotiView>
    );
}

const styles = StyleSheet.create({
    reactionRow: {
        flexDirection: 'row',
        // Spread the white reaction buttons evenly across the full row
        // width (space-between) instead of clustering them at the left.
        justifyContent: 'space-between',
        // Replaces the spacing the removed "Reactions" label used to give.
        marginTop: spacing.xl,
    },
    reactionCell: {
        width: REACTION_CELL_SIZE,
        height: REACTION_CELL_SIZE,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    reactionEmoji: {
        fontSize: 22,
        lineHeight: 24,
    },
    otherReactionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: spacing.md,
    },
});
