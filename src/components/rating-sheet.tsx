import * as Haptics from 'expo-haptics';
import { Star } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    Modal,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPalette, radius, spacing, typography } from '@/theme/theme';

interface RatingSheetProps {
    visible: boolean;
    busy: boolean;
    // Pre-fill the stars with an existing rating (e.g. re-rating a
    // previously-watched title). Null = no pre-selection.
    initialRating: number | null;
    // Called with the chosen 1-5 rating when the user taps Done, or
    // null when they dismissed without committing (Skip, backdrop tap,
    // hardware back).
    onSubmit: (rating: number | null) => void;
}

// Bottom-sheet star rating prompt used after a Watched transition.
// Caller controls visible / busy / initialRating; the sheet owns
// (a) the tentative selection the user is building toward Done and
// (b) the press-in fill preview that lights stars while the finger
// is down.
export function RatingSheet({
    visible,
    busy,
    initialRating,
    onSubmit,
}: RatingSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Tentative selection — committed only when Done is pressed.
    // Tapping the same star a second time deselects it (back to null).
    const [selected, setSelected] = useState<number | null>(initialRating);
    // Press-in preview — lights stars while the user holds. Clears on
    // press-out so the display falls back to `selected`.
    const [pressedRating, setPressedRating] = useState<number | null>(null);

    // Resync internal state to the prop each time the sheet opens, so
    // re-rate flows show the existing rating and first-rate flows
    // start unselected.
    useEffect(() => {
        if (visible) {
            setSelected(initialRating);
            setPressedRating(null);
        }
    }, [visible, initialRating]);

    function handleStarPressIn(value: number) {
        setPressedRating(value);
        // Letterboxd-style light impact as the finger lands. Fire and
        // forget — failures (unsupported device, etc.) are silent.
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    function handleStarPress(value: number) {
        // Tap-toggle: same star a second time clears the selection.
        setSelected((curr) => (curr === value ? null : value));
    }

    function handleDone() {
        onSubmit(selected);
    }

    function handleSkip() {
        onSubmit(null);
    }

    // Stars fill from the pressed preview first; when not pressing,
    // fall back to the committed selection.
    const effectiveRating = pressedRating ?? selected;
    const doneDisabled = busy || selected === null;

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={handleSkip}
        >
            <Pressable
                style={[styles.backdrop, { backgroundColor: palette.overlay }]}
                onPress={handleSkip}
            >
                <Pressable
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: palette.surface,
                            paddingBottom: insets.bottom + spacing.lg,
                        },
                    ]}
                    onPress={() => {}}
                >
                    <Text
                        style={[
                            typography.heading,
                            styles.title,
                            { color: palette.text },
                        ]}
                    >
                        How was it?
                    </Text>
                    <View style={styles.starsRow}>
                        {[1, 2, 3, 4, 5].map((value) => {
                            const filled =
                                effectiveRating !== null && value <= effectiveRating;
                            const color = filled ? palette.accent : palette.textMuted;
                            return (
                                <Pressable
                                    key={value}
                                    onPressIn={() => handleStarPressIn(value)}
                                    onPressOut={() => setPressedRating(null)}
                                    onPress={() => handleStarPress(value)}
                                    disabled={busy}
                                    hitSlop={spacing.xs}
                                    style={({ pressed }) => [
                                        styles.starButton,
                                        { opacity: pressed || busy ? 0.6 : 1 },
                                    ]}
                                >
                                    <Star
                                        color={color}
                                        fill={filled ? palette.accent : 'transparent'}
                                        size={36}
                                    />
                                </Pressable>
                            );
                        })}
                    </View>
                    <Pressable
                        onPress={handleDone}
                        disabled={doneDisabled}
                        style={({ pressed }) => [
                            styles.doneButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: doneDisabled ? 0.4 : pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Done
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={handleSkip}
                        disabled={busy}
                        style={({ pressed }) => [
                            styles.skipButton,
                            { opacity: pressed || busy ? 0.6 : 1 },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textMuted },
                            ]}
                        >
                            Skip
                        </Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
    },
    title: {
        textAlign: 'center',
        marginBottom: spacing.lg,
    },
    starsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.sm,
    },
    starButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    doneButton: {
        alignSelf: 'center',
        marginTop: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.sm,
    },
});
