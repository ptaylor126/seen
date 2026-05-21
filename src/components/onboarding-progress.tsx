import { StyleSheet, useColorScheme, View } from 'react-native';

import { getPalette, spacing } from '@/theme/theme';

interface OnboardingProgressProps {
    currentStep: number;
    totalSteps: number;
}

const BAR_HEIGHT = 3;

// Stripe-style linear step indicator pinned to the top of each
// onboarding screen (just below the safe-area top, above the header
// row). Past + current steps fill in palette.accent; future steps are
// dimmed palette.textMuted at low opacity. Equal-width segments so the
// total fills the screen width regardless of step count.
export function OnboardingProgress({
    currentStep,
    totalSteps,
}: OnboardingProgressProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const steps = Array.from({ length: totalSteps }, (_, i) => i + 1);
    return (
        <View style={styles.row}>
            {steps.map((step) => {
                const filled = step <= currentStep;
                return (
                    <View
                        key={step}
                        style={[
                            styles.bar,
                            {
                                backgroundColor: filled
                                    ? palette.accent
                                    : palette.textMuted,
                                opacity: filled ? 1 : 0.3,
                            },
                        ]}
                    />
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        gap: spacing.xs,
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
    bar: {
        flex: 1,
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
    },
});
