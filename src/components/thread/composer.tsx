import { ArrowUp } from 'lucide-react-native';
import {
    Pressable,
    StyleSheet,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    interpolate,
    useAnimatedStyle,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { COMMENT_MAX_CHARS } from '@/components/thread/shared';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// Composer avatar — larger, roughly the height of the taller pill field.
const COMPOSER_AVATAR_SIZE = 40;

// The thread's pinned comment composer bar. Extracted from rec/[recId].tsx —
// the screen pins it below its ScrollView inside the KeyboardAvoidingView.
//
// Reads as its own zone via the palette.surface fill alone (no top
// border/shadow — those read as a hard stroke against the plum page). Bottom
// clearance is SELF-ANIMATED off the keyboard progress: snug to the safe-area
// edge when closed, flush above the keyboard when open, interpolating in sync
// with the KAV's lift (one animated source, no discrete jump). Disabled state
// mirrors the button's enable rule so the affordance stays obvious.
export function ThreadComposer({
    value,
    onChangeText,
    onSend,
    busy,
    placeholder,
    onFocus,
    autoFocus,
    avatarUrl,
    avatarDisplayName,
    avatarSeedId,
}: {
    value: string;
    onChangeText: (value: string) => void;
    onSend: () => void;
    busy: boolean;
    placeholder: string;
    // Optional focus callback — the rec screen scrolls its thread to the end
    // on focus (top-anchored). The chat omits it: its bottom-anchored list
    // already hugs the composer and lifts on the keyboard rise.
    onFocus?: () => void;
    // Open the keyboard on mount (chat threads arrive ready to type). Off by
    // default so the rec thread stays arrive-reading.
    autoFocus?: boolean;
    // Current user's own avatar, left of the input.
    avatarUrl: string | null;
    avatarDisplayName: string;
    avatarSeedId: string;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Keyboard progress (0 closed → 1 open) drives the bottom clearance so it
    // moves WITH the keyboard rather than swapping discretely: home-indicator
    // inset when closed → a small gap above the keyboard's top edge when open
    // (spacing.md, not flush).
    const { progress } = useReanimatedKeyboardAnimation();
    const clearanceStyle = useAnimatedStyle(() => ({
        paddingBottom: interpolate(
            progress.value,
            [0, 1],
            [insets.bottom, spacing.md],
        ),
    }));

    return (
        <Animated.View
            style={[
                styles.composer,
                { backgroundColor: palette.surface },
                clearanceStyle,
            ]}
        >
            {/* Current user's own avatar, left of the input —
                larger now, roughly the height of the pill field. */}
            <Avatar
                avatarUrl={avatarUrl}
                displayName={avatarDisplayName}
                seedId={avatarSeedId}
                size={COMPOSER_AVATAR_SIZE}
            />
            {/* Soft pill field with the send arrow inside it at
                the right edge. */}
            <View
                style={[
                    styles.composerFieldWrap,
                    { backgroundColor: palette.bg },
                ]}
            >
                <TextInput
                    value={value}
                    onChangeText={onChangeText}
                    onFocus={onFocus}
                    autoFocus={autoFocus}
                    placeholder={placeholder}
                    placeholderTextColor={palette.textMuted}
                    editable={!busy}
                    multiline
                    maxLength={COMMENT_MAX_CHARS}
                    style={[
                        styles.composerInput,
                        typography.body,
                        { color: palette.text },
                    ]}
                />
                <Pressable
                    onPress={onSend}
                    disabled={
                        busy ||
                        value.trim().length === 0 ||
                        value.length > COMMENT_MAX_CHARS
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Post comment"
                    style={({ pressed }) => [
                        styles.composerSendInline,
                        {
                            // Solid accent circle with a white
                            // up-arrow; dims when there's nothing
                            // to send.
                            backgroundColor: palette.accent,
                            opacity:
                                busy || value.trim().length === 0
                                    ? 0.4
                                    : pressed
                                        ? 0.8
                                        : 1,
                        },
                    ]}
                >
                    <ArrowUp
                        color={palette.textInverse}
                        size={20}
                        strokeWidth={2.5}
                    />
                </Pressable>
            </View>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    composer: {
        flexDirection: 'row',
        // Avatar vertically centered against the taller pill field.
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        // paddingBottom is set inline (safe-area inset, keyboard-aware).
        // No top border or shadow — the surface fill alone separates the
        // bar from the plum page; a stroke/shadow read as a hard line.
    },
    composerFieldWrap: {
        // Rounded-rectangle field holding the input + the inline filled
        // send circle. radius.lg (not radius.full): at single-line height
        // it clamps to ~half-height so it still reads as a rounded pill,
        // but as the field grows to multiple lines it holds a constant
        // gentle corner instead of an oversized half-height pill curve.
        // The surface fill lives here (the TextInput inside is
        // transparent).
        flex: 1,
        flexDirection: 'row',
        // Center the send circle (and single-line text) vertically in the
        // field so the arrow reads centered.
        alignItems: 'center',
        borderRadius: radius.lg,
        // No border/outline — just the filled pill.
        paddingLeft: spacing.md,
        // Roomier right padding so the send circle sits comfortably off
        // the field's right edge (moves the whole circle in, not the
        // arrow within it).
        paddingRight: spacing.sm,
        paddingVertical: spacing.xs,
    },
    composerInput: {
        flex: 1,
        maxHeight: 120,
        // Transparent text area inside the pill; the pill chrome lives on
        // composerFieldWrap.
        paddingVertical: spacing.sm,
        // Right inset on the input itself (not a wrap gap) so long text stays
        // inset from its own edge while typing — mirrors the wrap's
        // paddingLeft: spacing.md on the left.
        paddingRight: spacing.md,
    },
    composerSendInline: {
        // Solid filled circle (accent set inline) with a white up-arrow,
        // sitting at the field's right edge.
        width: 32,
        height: 32,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
