import { useEffect, useState } from 'react';
import {
    Dimensions,
    Modal,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, {
    Easing,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/text';
import { TextInput } from '@/components/text-input';
import { button, getPalette, radius, spacing, typography } from '@/theme/theme';

interface DeclineSheetProps {
    visible: boolean;
    // Sender's first name, for the optional-note prompt ("Add a note to
    // Jordan?"). Falls back to a generic prompt when empty.
    senderName: string;
    busy: boolean;
    onCancel: () => void;
    // Confirm declining. `note` is the trimmed note ('' when blank — the
    // caller maps '' → null for dismiss_reason).
    onConfirm: (note: string) => void;
}

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;
const NOTE_MAX = 500;

// Decline-a-recommendation sheet. Same presentation as RatingSheet /
// WatchersSheet — backdrop fades (stationary) while the panel slides up —
// with an optional note field. Declining is silent by default: no note
// required. The panel rides up with the keyboard so the Confirm button
// stays reachable while typing.
export function DeclineSheet({
    visible,
    senderName,
    busy,
    onCancel,
    onConfirm,
}: DeclineSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Animated keyboard height (negative: 0 → -keyboardHeight) + progress
    // (0 closed → 1 open) drive the sheet's bottom padding. No KeyboardAvoiding-
    // View: the sheet stays anchored at the screen bottom and this padding lifts
    // the CONTENT above the keyboard while the sheet's background fills all the
    // way down — the keyboard covers the excess, so the sheet docks flush to the
    // keyboard's top edge with no gap.
    const { height: keyboardHeight, progress: keyboardProgress } =
        useReanimatedKeyboardAnimation();

    const [mounted, setMounted] = useState(visible);
    const [note, setNote] = useState('');
    const progress = useSharedValue(visible ? 1 : 0);
    // 1 while the sheet is open/settling, 0 the instant dismissal starts. When
    // dismissing we FREEZE the keyboard-driven padding (frozenPad) so the
    // content can't reflow as the sheet slides out.
    const active = useSharedValue(visible ? 1 : 0);
    const frozenPad = useSharedValue(insets.bottom + spacing.lg);
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );

    useEffect(() => {
        if (visible) {
            setNote('');
            setMounted(true);
            active.value = 1;
            progress.value = withTiming(1, {
                duration: OPEN_MS,
                easing: Easing.out(Easing.cubic),
            });
        } else {
            // Freeze layout inputs before the exit slide so nothing reflows.
            active.value = 0;
            progress.value = withTiming(
                0,
                { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) },
                (finished) => {
                    if (finished) runOnJS(setMounted)(false);
                },
            );
        }
    }, [visible, progress, active]);

    const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    // Panel slide (translateY) always runs — it IS the exit animation. The
    // keyboard-driven bottom padding lifts content above the keyboard
    // (-keyboardHeight) plus a constant lg gap, minus the home-indicator inset
    // as the keyboard rises (only needed when closed). While dismissing (active
    // === 0) it holds frozenPad — frozen at the last open value — so the exit is
    // a pure slide with no reflow.
    const sheetStyle = useAnimatedStyle(() => {
        const translateY = interpolate(progress.value, [0, 1], [sheetHeight, 0]);
        let paddingBottom;
        if (active.value === 1) {
            paddingBottom =
                -keyboardHeight.value +
                spacing.lg +
                insets.bottom * (1 - keyboardProgress.value);
            frozenPad.value = paddingBottom;
        } else {
            paddingBottom = frozenPad.value;
        }
        return { transform: [{ translateY }], paddingBottom };
    });

    // Hold the sender name while dismissing so the prompt/helper subtext can't
    // change mid-exit if the caller clears it on close (parity with
    // RequestRecSheet — the caller here keeps it stable, but the guard is free).
    const [heldSenderName, setHeldSenderName] = useState(senderName);
    useEffect(() => {
        if (visible) setHeldSenderName(senderName);
    }, [visible, senderName]);
    const prompt = heldSenderName
        ? `Add a note to ${heldSenderName}?`
        : 'Add a note?';

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            onRequestClose={onCancel}
        >
            {/* No KeyboardAvoidingView: the sheet is anchored at the bottom and
                the keyboard-driven paddingBottom (see sheetStyle) lifts the
                content above the keyboard while the background fills to the
                screen bottom, so it docks flush to the keyboard. */}
                <View style={styles.container}>
                    <AnimatedPressable
                        style={[
                            StyleSheet.absoluteFill,
                            { backgroundColor: palette.overlay },
                            backdropStyle,
                        ]}
                        onPress={onCancel}
                    />
                    <Reanimated.View
                        onLayout={(e) =>
                            setSheetHeight(e.nativeEvent.layout.height)
                        }
                        style={[
                            styles.sheet,
                            { backgroundColor: palette.surface },
                            sheetStyle,
                        ]}
                    >
                        <Text
                            style={[
                                typography.heading,
                                styles.title,
                                { color: palette.text },
                            ]}
                        >
                            Not for me?
                        </Text>
                        <Text
                            style={[
                                typography.caption,
                                styles.prompt,
                                { color: palette.textMuted },
                            ]}
                        >
                            {prompt}
                        </Text>
                        <TextInput
                            value={note}
                            onChangeText={setNote}
                            editable={!busy}
                            multiline
                            maxLength={NOTE_MAX}
                            placeholder="Add a note…"
                            placeholderTextColor={palette.textMuted}
                            style={[
                                styles.input,
                                typography.body,
                                {
                                    color: palette.text,
                                    backgroundColor: palette.bg,
                                },
                            ]}
                        />
                        {/* Quiet reassurance that declining is silent by
                            default — the sender only hears about it if a
                            note is written. */}
                        <Text
                            style={[
                                typography.caption,
                                styles.helper,
                                { color: palette.textMuted },
                            ]}
                        >
                            {heldSenderName || 'They'} won&apos;t be notified
                            unless you add a note.
                        </Text>
                        <Pressable
                            onPress={() => onConfirm(note.trim())}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel="Not for me"
                            style={({ pressed }) => [
                                styles.confirmButton,
                                {
                                    backgroundColor: palette.accent,
                                    opacity: busy ? 0.4 : pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.textInverse },
                                ]}
                            >
                                Not for me
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={onCancel}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            style={({ pressed }) => [
                                styles.cancelButton,
                                { opacity: pressed || busy ? 0.6 : 1 },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Cancel
                            </Text>
                        </Pressable>
                    </Reanimated.View>
                </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.sm,
    },
    title: {
        textAlign: 'center',
    },
    prompt: {
        textAlign: 'center',
    },
    helper: {
        // Quiet helper under the note field — not heavy/preachy.
        textAlign: 'center',
        marginTop: spacing.xs,
    },
    input: {
        minHeight: 80,
        maxHeight: 160,
        borderRadius: radius.md,
        // Even internal padding so the note text doesn't sit against the
        // field's edges.
        padding: spacing.md,
        textAlignVertical: 'top',
        marginTop: spacing.xs,
    },
    confirmButton: {
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: spacing.md,
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
    },
    cancelButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.xs,
    },
});
