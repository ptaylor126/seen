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
    // Called with the chosen 1-5 rating, or null when the user dismissed
    // without picking (Skip button, backdrop tap, hardware back).
    onSubmit: (rating: number | null) => void;
}

// Bottom-sheet star rating prompt used after a Watched transition.
// Stateless from the caller's perspective: caller controls `visible` and
// the busy flag; this component owns only the press-fill preview.
export function RatingSheet({ visible, busy, onSubmit }: RatingSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Drives the press-in fill: while the user holds the 4th star,
    // stars 1-4 light up before commit fires on release.
    const [pressedRating, setPressedRating] = useState<number | null>(null);

    // Reset the press-fill preview each open so a previous press doesn't
    // bleed into the next session (e.g. when the user re-taps Watched).
    useEffect(() => {
        if (visible) setPressedRating(null);
    }, [visible]);

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={() => onSubmit(null)}
        >
            <Pressable
                style={[styles.backdrop, { backgroundColor: palette.overlay }]}
                onPress={() => onSubmit(null)}
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
                                pressedRating !== null && value <= pressedRating;
                            const color = filled ? palette.accent : palette.textMuted;
                            return (
                                <Pressable
                                    key={value}
                                    onPressIn={() => setPressedRating(value)}
                                    onPressOut={() => setPressedRating(null)}
                                    onPress={() => onSubmit(value)}
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
                        onPress={() => onSubmit(null)}
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
        gap: spacing.sm,
        paddingVertical: spacing.sm,
    },
    starButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.sm,
    },
});
