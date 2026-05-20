import { StyleSheet, useColorScheme, View } from 'react-native';

import { getPalette, spacing } from '@/theme/theme';

interface OnboardingDotsProps {
    currentStep: number;
    totalSteps: number;
}

const DOT_SIZE = 6;

// Step indicator pinned to the bottom of each onboarding screen. The
// current step's dot uses palette.accent; the rest are textMuted. Kept
// deliberately small — this is orientation, not a navigation control.
export function OnboardingDots({ currentStep, totalSteps }: OnboardingDotsProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const dots = Array.from({ length: totalSteps }, (_, i) => i + 1);
    return (
        <View style={styles.row}>
            {dots.map((step) => (
                <View
                    key={step}
                    style={[
                        styles.dot,
                        {
                            backgroundColor:
                                step === currentStep
                                    ? palette.accent
                                    : palette.textMuted,
                            opacity: step === currentStep ? 1 : 0.4,
                        },
                    ]}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.md,
    },
    dot: {
        width: DOT_SIZE,
        height: DOT_SIZE,
        borderRadius: DOT_SIZE / 2,
    },
});
