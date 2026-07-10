import { ArrowUp } from 'lucide-react-native';
import {
    Pressable,
    StyleSheet,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { COMMENT_MAX_CHARS } from '@/components/thread/shared';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// Composer avatar — larger, roughly the height of the taller pill field.
const COMPOSER_AVATAR_SIZE = 40;

// The thread's pinned comment composer bar. Extracted verbatim from
// rec/[recId].tsx — the screen pins it below its ScrollView inside the
// KeyboardAvoidingView and owns the keyboard listeners (they also drive the
// screen's scroll), passing `keyboardOpen` down for the bottom padding.
//
// Reads as its own zone via the palette.surface fill alone (no top
// border/shadow — those read as a hard stroke against the plum page). Bottom
// padding is keyboard-aware (see inline): snug to the safe-area edge when
// closed, flush above the keyboard when open. Disabled state mirrors the
// button's enable rule so the affordance stays obvious.
export function ThreadComposer({
    value,
    onChangeText,
    onSend,
    busy,
    placeholder,
    keyboardOpen,
    onFocus,
    avatarUrl,
    avatarDisplayName,
    avatarSeedId,
}: {
    value: string;
    onChangeText: (value: string) => void;
    onSend: () => void;
    busy: boolean;
    placeholder: string;
    // Keyboard up → drop the composer's bottom safe-area inset while typing
    // (the keyboard already covers the home-indicator area, so keeping the
    // inset leaves a white gap above the keyboard).
    keyboardOpen: boolean;
    // Focus fallback (e.g. a hardware keyboard, where no keyboard event
    // fires) — the screen scrolls its thread to the end.
    onFocus: () => void;
    // Current user's own avatar, left of the input.
    avatarUrl: string | null;
    avatarDisplayName: string;
    avatarSeedId: string;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    return (
        <View
            style={[
                styles.composer,
                {
                    backgroundColor: palette.surface,
                    // Keyboard up → the home-indicator inset is
                    // covered by the keyboard, so drop it to a small
                    // gap. spacing.md (not spacing.sm) gives a little
                    // breathing room above the keyboard's top edge so
                    // the input doesn't sit flush against it — minimal
                    // bump, NOT keyboardVerticalOffset (a non-zero
                    // offset previously over-padded; see the KAV note).
                    // Keyboard down → just the safe-area inset, so
                    // the bar sits snug at the very bottom (no extra
                    // gap above the home indicator).
                    paddingBottom: keyboardOpen ? spacing.md : insets.bottom,
                },
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
                    // Fallback for the focus-without-keyboard-event
                    // case (e.g. a hardware keyboard, where no
                    // keyboardWillShow/DidShow fires): still pull the
                    // latest message above the input on focus.
                    onFocus={onFocus}
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
        </View>
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
