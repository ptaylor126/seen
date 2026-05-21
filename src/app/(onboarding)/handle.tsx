import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import { useKeyboardOpen } from '@/hooks/use-keyboard-open';
import { validateHandle } from '@/lib/onboarding-utils';
import supabase from '@/lib/supabase';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

export default function HandleScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const keyboardOpen = useKeyboardOpen();

    const [handle, setHandle] = useState('');
    const [busy, setBusy] = useState(false);
    const validation = validateHandle(handle);
    const canSubmit = validation.valid && !busy;

    async function handleContinue() {
        if (!canSubmit) return;
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Uniqueness is enforced by the unique index on profiles.handle.
            // We surface a friendlier error on conflict (Postgres 23505).
            const { error } = await supabase
                .from('profiles')
                .update({ handle: handle.trim() })
                .eq('id', userId);
            if (error) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    (error as { code?: string }).code === '23505'
                ) {
                    Alert.alert('Handle taken', 'Someone already has that one. Try another.');
                    return;
                }
                throw error;
            }

            router.push('/(onboarding)/display-name');
        } catch (err) {
            console.error('handle save failed:', err);
            Alert.alert(
                "Couldn't save",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    // Reason line: shown beneath the input. Only after the user has
    // typed something — empty input shouldn't scream "too short" at
    // them on first focus.
    const showReason = handle.length > 0 && validation.reason;

    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: palette.bg }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <OnboardingProgress currentStep={2} totalSteps={6} />
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
                    Pick a handle
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    This is how friends find you on Seen. Just letters,
                    numbers, underscores.
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
                    <Text
                        style={[
                            typography.body,
                            styles.atPrefix,
                            { color: palette.textMuted },
                        ]}
                    >
                        @
                    </Text>
                    <TextInput
                        value={handle}
                        onChangeText={(t) => setHandle(t.toLowerCase())}
                        placeholder="handle"
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                        editable={!busy}
                        returnKeyType="next"
                        onSubmitEditing={handleContinue}
                        // Hardcoded so the keyboard never flashes dark
                        // during the welcome → handle transition, even
                        // if useColorScheme() momentarily returns 'dark'
                        // while iOS finishes setting up the new view.
                        keyboardAppearance="light"
                        style={[styles.input, typography.body, { color: palette.text }]}
                    />
                </View>
                {showReason ? (
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {validation.reason}
                    </Text>
                ) : null}
            </View>
            <View
                style={[
                    styles.footer,
                    {
                        paddingBottom: keyboardOpen
                            ? spacing.md
                            : insets.bottom + spacing.md,
                    },
                ]}
            >
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
            </View>
        </SafeAreaView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: {
        paddingVertical: spacing.sm,
    },
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
        gap: spacing.xs,
        marginTop: spacing.md,
    },
    atPrefix: { fontWeight: '600' },
    input: { flex: 1, height: '100%' },
    footer: {
        // paddingBottom set inline — see last-watched.tsx for the
        // pattern (LayoutAnimation in useKeyboardOpen animates the
        // value change in sync with the keyboard slide).
        gap: spacing.sm,
    },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
