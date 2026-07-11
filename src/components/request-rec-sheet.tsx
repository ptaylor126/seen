import { useEffect, useState } from 'react';
import {
    Dimensions,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
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

import { button, getPalette, radius, spacing, typography } from '@/theme/theme';

interface RequestRecSheetProps {
    visible: boolean;
    // Friend's first name, for the prompt ("What are you in the mood for,
    // from Jordan?"). Falls back to a generic prompt when empty.
    friendName: string;
    busy: boolean;
    onCancel: () => void;
    // Send the request. `note` is the trimmed note ('' when blank — the
    // caller maps '' → no note).
    onSend: (note: string) => void;
}

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;
const NOTE_MAX = 500;

// Request-a-recommendation sheet. Same presentation as DeclineSheet —
// backdrop fades (stationary) while the panel slides up — with a single
// optional note field ("what are you in the mood for", doubles as the
// vibe/category). The panel rides up with the keyboard so Send stays
// reachable while typing.
export function RequestRecSheet({
    visible,
    friendName,
    busy,
    onCancel,
    onSend,
}: RequestRecSheetProps) {
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

    // The caller sets friendName to '' when it closes (its target → null), which
    // would otherwise flip the prompt text mid-exit. Hold the last name while
    // dismissing so the subtext is frozen as the sheet slides out — only adopt a
    // new name while the sheet is visible.
    const [heldFriendName, setHeldFriendName] = useState(friendName);
    useEffect(() => {
        if (visible) setHeldFriendName(friendName);
    }, [visible, friendName]);
    const prompt = heldFriendName
        ? `What are you in the mood for? ${heldFriendName} will see this.`
        : 'What are you in the mood for?';

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
                            Request a recommendation
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
                            placeholder="Something funny, a thriller, a comfort watch…"
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
                        <Pressable
                            onPress={() => onSend(note.trim())}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel="Send request"
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
                                Send request
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
