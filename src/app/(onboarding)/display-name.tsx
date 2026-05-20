import { useRouter } from 'expo-router';
import { ChevronLeft, Dices } from 'lucide-react-native';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingDots } from '@/components/onboarding-dots';
import { containsProfanity, randomDisplayName } from '@/lib/onboarding-utils';
import supabase from '@/lib/supabase';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

const MAX_LENGTH = 30;

export default function DisplayNameScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    // Seed with a random name on first render so the dice button has
    // somewhere to roll from; the user can clear and type their own.
    const [displayName, setDisplayName] = useState(randomDisplayName);
    const [busy, setBusy] = useState(false);

    const trimmed = displayName.trim();
    const hasProfanity = trimmed.length > 0 && containsProfanity(trimmed);
    const canSubmit =
        trimmed.length > 0 &&
        trimmed.length <= MAX_LENGTH &&
        !hasProfanity &&
        !busy;

    async function saveAndAdvance(name: string) {
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error } = await supabase
                .from('profiles')
                .update({ display_name: name })
                .eq('id', userId);
            if (error) throw error;

            router.push('/(onboarding)/last-watched');
        } catch (err) {
            console.error('display name save failed:', err);
            Alert.alert(
                "Couldn't save",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleContinue() {
        if (!canSubmit) return;
        await saveAndAdvance(trimmed);
    }

    async function handleSkip() {
        if (busy) return;
        // Skip means "pick something for me" — generate a random name
        // and persist it so the rest of the app has something to show.
        await saveAndAdvance(randomDisplayName());
    }

    function handleRandomize() {
        setDisplayName(randomDisplayName());
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top', 'bottom']}
        >
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <ChevronLeft color={palette.accent} size={28} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <Text style={[typography.display, { color: palette.text }]}>
                    How should we show your name?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    What your friends see when you recommend things. You can
                    change this later.
                </Text>
                <View
                    style={[
                        styles.inputRow,
                        {
                            backgroundColor: palette.surface,
                            borderColor: palette.border,
                        },
                    ]}
                >
                    <TextInput
                        value={displayName}
                        onChangeText={setDisplayName}
                        placeholder="Display name"
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="words"
                        autoCorrect={false}
                        maxLength={MAX_LENGTH}
                        editable={!busy}
                        returnKeyType="done"
                        onSubmitEditing={handleContinue}
                        style={[styles.input, typography.body, { color: palette.text }]}
                    />
                    <Pressable
                        onPress={handleRandomize}
                        disabled={busy}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [
                            styles.diceButton,
                            { opacity: pressed ? 0.6 : 1 },
                        ]}
                    >
                        <Dices color={palette.accent} size={22} />
                    </Pressable>
                </View>
                {hasProfanity ? (
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        Please pick a different name.
                    </Text>
                ) : null}
            </View>
            <View style={styles.footer}>
                <Pressable
                    onPress={handleContinue}
                    disabled={!canSubmit}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: !canSubmit ? 0.4 : pressed ? 0.6 : 1,
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
                        { opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        Skip
                    </Text>
                </Pressable>
                <OnboardingDots currentStep={3} totalSteps={6} />
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
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        height: 48,
        borderRadius: radius.sm,
        borderWidth: 1,
        gap: spacing.sm,
        marginTop: spacing.md,
    },
    input: { flex: 1, height: '100%' },
    diceButton: {
        padding: spacing.xs,
    },
    footer: {
        gap: spacing.sm,
        paddingBottom: spacing.md,
        alignItems: 'stretch',
    },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
