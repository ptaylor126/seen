import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

export default function WelcomeScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top', 'bottom']}
        >
            <OnboardingProgress currentStep={1} totalSteps={6} />
            <View style={styles.body}>
                <Text style={[typography.display, { color: palette.text }]}>
                    Welcome to Seen
                </Text>
                <Text
                    style={[
                        typography.body,
                        styles.lead,
                        { color: palette.textMuted },
                    ]}
                >
                    Recommendations from people you trust, not algorithms.
                    Let&apos;s get you set up.
                </Text>
            </View>
            <View style={styles.footer}>
                <Pressable
                    onPress={() => router.push('/(onboarding)/handle')}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Get started
                    </Text>
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    body: {
        flex: 1,
        justifyContent: 'center',
        gap: spacing.md,
    },
    lead: {
        // Slightly larger line spacing for legibility on the lead text.
    },
    footer: {
        gap: spacing.sm,
        paddingBottom: spacing.md,
    },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
