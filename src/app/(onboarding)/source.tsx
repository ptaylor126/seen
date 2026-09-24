import { useRouter } from 'expo-router';
import {
    CaretLeft,
} from 'phosphor-react-native';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { OnboardingProgress } from '@/components/onboarding-progress';
import { Text } from '@/components/text';
import supabase from '@/lib/supabase';
import {
    button,
    getPalette,
    spacing,
    typography,
} from '@/theme/theme';

// "How did you hear about Seen?" — its own step (moved off handle.tsx,
// which couldn't fit a handle field + this 7-chip question + Continue above
// the keyboard). No text input on this screen at all, so no keyboard, so no
// overlap risk — same shape as poster-grid.tsx (normal-flow footer, no
// KeyboardAvoidingView/KeyboardStickyView needed). Values mirror the
// profiles_signup_source_check CHECK constraint
// (20260922120000_add_profile_signup_source.sql) — keep the two in lockstep
// if this list ever changes.
type SignupSource =
    | 'app_store_search'
    | 'reddit'
    | 'tiktok'
    | 'instagram'
    | 'x'
    | 'friend'
    | 'other';

const SIGNUP_SOURCE_OPTIONS: ReadonlyArray<{
    value: SignupSource;
    label: string;
}> = [
    { value: 'app_store_search', label: 'App Store / Play search' },
    { value: 'reddit', label: 'Reddit' },
    { value: 'tiktok', label: 'TikTok' },
    { value: 'instagram', label: 'Instagram' },
    { value: 'x', label: 'X' },
    { value: 'friend', label: 'A friend' },
    { value: 'other', label: 'Other' },
];

export default function SourceScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();

    const [signupSource, setSignupSource] = useState<SignupSource | null>(
        null,
    );
    const [busy, setBusy] = useState(false);
    // Single-select: picking a new option replaces the old one; tapping the
    // active option again clears it back to "no answer" — same tap-toggle
    // pattern the rating stars use for an optional selection.
    function toggleSignupSource(value: SignupSource) {
        setSignupSource((prev) => (prev === value ? null : value));
    }

    // Continue always writes — signupSource may be null (nothing tapped),
    // which is exactly the column's own "skipped/unknown" value. Never
    // gated on a selection.
    async function handleContinue() {
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error } = await supabase
                .from('profiles')
                .update({ signup_source: signupSource })
                .eq('id', userId);
            if (error) throw error;

            router.push('/(onboarding)/currently-watching');
        } catch (err) {
            console.error('signup source save failed:', err);
            Alert.alert(
                "Couldn't save",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    // Skip for now — a full bypass, same as invite.tsx's Skip: no write at
    // all (nothing tapped is already what an unwritten row already reads
    // as), just move on.
    function handleSkip() {
        router.push('/(onboarding)/currently-watching');
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <OnboardingProgress currentStep={3} totalSteps={5} />
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <CaretLeft
                        color={palette.accent}
                        size={28}
                    />
                </Pressable>
            </View>

            <View style={styles.body}>
                <Text style={[typography.display, { color: palette.text }]}>
                    How did you hear about Seen?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Totally optional — just helps us understand how people
                    find Seen.
                </Text>
                <View style={styles.chips}>
                    {SIGNUP_SOURCE_OPTIONS.map((option) => (
                        <Chip
                            key={option.value}
                            label={option.label}
                            active={signupSource === option.value}
                            onPress={() => toggleSignupSource(option.value)}
                        />
                    ))}
                </View>
            </View>

            <View
                style={[
                    styles.footer,
                    { paddingBottom: insets.bottom + spacing.sm },
                ]}
            >
                <Pressable
                    onPress={handleContinue}
                    disabled={busy}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: busy ? 0.6 : pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    {busy ? (
                        <ActivityIndicator color={palette.textInverse} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Continue
                        </Text>
                    )}
                </Pressable>
                <Pressable
                    onPress={handleSkip}
                    disabled={busy}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.skipButton,
                        { opacity: pressed || busy ? 0.6 : 1 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        Skip for now
                    </Text>
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: { paddingVertical: spacing.sm },
    body: {
        flex: 1,
        gap: spacing.md,
        paddingTop: spacing.lg,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        marginTop: spacing.sm,
    },
    footer: { gap: spacing.sm },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
