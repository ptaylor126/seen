import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPalette, radius, spacing, typography } from '@/theme/theme';

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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
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

    const [mounted, setMounted] = useState(visible);
    const [note, setNote] = useState('');
    const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );

    useEffect(() => {
        if (visible) {
            setNote('');
            setMounted(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: OPEN_MS,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }).start();
        } else {
            Animated.timing(progress, {
                toValue: 0,
                duration: CLOSE_MS,
                easing: Easing.in(Easing.cubic),
                useNativeDriver: true,
            }).start(({ finished }) => {
                if (finished) setMounted(false);
            });
        }
    }, [visible, progress]);

    const translateY = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [sheetHeight, 0],
    });

    const prompt = senderName
        ? `Add a note to ${senderName}? (optional)`
        : 'Add a note? (optional)';

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            onRequestClose={onCancel}
        >
            <KeyboardAvoidingView
                style={styles.fill}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <View style={styles.container}>
                    <AnimatedPressable
                        style={[
                            StyleSheet.absoluteFill,
                            { backgroundColor: palette.overlay, opacity: progress },
                        ]}
                        onPress={onCancel}
                    />
                    <Animated.View
                        onLayout={(e) =>
                            setSheetHeight(e.nativeEvent.layout.height)
                        }
                        style={[
                            styles.sheet,
                            {
                                backgroundColor: palette.surface,
                                paddingBottom: insets.bottom + spacing.lg,
                                transform: [{ translateY }],
                            },
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
                            {senderName || 'They'} won&apos;t be notified
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
                    </Animated.View>
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
    helper: {
        // Quiet helper under the note field — not heavy/preachy.
        textAlign: 'center',
        marginTop: spacing.xs,
    },
    input: {
        minHeight: 80,
        maxHeight: 160,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
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
