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
import {
    KeyboardAvoidingView,
    useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Reanimated, {
    Easing,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPalette, radius, spacing, typography } from '@/theme/theme';

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
    // Keyboard progress (0 closed → 1 open) drives the sheet's bottom clearance
    // on the SAME clock as the KeyboardAvoidingView lift, so padding and lift
    // move together — no snap. Mirrors the commit-3 bar fix.
    const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();

    const [mounted, setMounted] = useState(visible);
    const [note, setNote] = useState('');
    const progress = useSharedValue(visible ? 1 : 0);
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );

    useEffect(() => {
        if (visible) {
            setNote('');
            setMounted(true);
            progress.value = withTiming(1, {
                duration: OPEN_MS,
                easing: Easing.out(Easing.cubic),
            });
        } else {
            progress.value = withTiming(
                0,
                { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) },
                (finished) => {
                    if (finished) runOnJS(setMounted)(false);
                },
            );
        }
    }, [visible, progress]);

    const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    // Panel slide + the keyboard-synced bottom clearance: insets.bottom + lg
    // when closed (home-indicator clearance), easing to just lg as the keyboard
    // opens (the KAV has lifted the sheet to the keyboard's edge, so the inset
    // would otherwise be dead space below Cancel).
    const sheetStyle = useAnimatedStyle(() => ({
        transform: [
            { translateY: interpolate(progress.value, [0, 1], [sheetHeight, 0]) },
        ],
        paddingBottom: interpolate(
            keyboardProgress.value,
            [0, 1],
            [insets.bottom + spacing.lg, spacing.lg],
        ),
    }));

    const prompt = friendName
        ? `What are you in the mood for? ${friendName} will see this.`
        : 'What are you in the mood for?';

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            onRequestClose={onCancel}
        >
            {/* keyboard-controller KAV: padding on both platforms. Note: this
                sits inside an RN Modal, whose Android window the library's
                inset handling may not reach — verify on device (commit 5). */}
            <KeyboardAvoidingView
                style={styles.fill}
                behavior="padding"
            >
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
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
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
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    cancelButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.xs,
    },
});
