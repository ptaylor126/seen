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
import { useKeyboard } from '@/hooks/use-keyboard-open';
import { validateHandle } from '@/lib/onboarding-utils';
import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

export default function HandleScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { open: keyboardOpen, height: keyboardHeight } = useKeyboard();

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

            const trimmed = handle.trim();
            // display_name is auto-derived from the handle (capitalize
            // the first letter; rest preserved — e.g. "paul" → "Paul",
            // "paul_t" → "Paul_t"). We write both fields in the same
            // UPDATE so onboarding doesn't need a dedicated display-name
            // step. Users can edit display_name later from
            // /(tabs)/profile if they want something different.
            const displayName =
                trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
            // Uniqueness on handle is enforced by the unique index on
            // profiles.handle. We surface a friendlier error on
            // conflict (Postgres 23505).
            const { error } = await supabase
                .from('profiles')
                .update({ handle: trimmed, display_name: displayName })
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

            router.push('/(onboarding)/best-watched');
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
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <SafeAreaView
            style={styles.root}
            edges={['top']}
        >
            <OnboardingProgress currentStep={2} totalSteps={4} />
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <ChevronLeft
                        color={palette.accent}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
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
                    {/* @ is rendered as an absolutely-positioned overlay
                        rather than a flex sibling. Sitting it beside
                        the TextInput in flex layout produced (a)
                        baseline mismatch between Text and TextInput
                        and (b) a visible gap that made "@" and the
                        typed handle read as two elements. The overlay
                        approach + paddingLeft on the input lets them
                        read as one unit. */}
                    <View style={styles.atContainer}>
                        <Text
                            style={[
                                typography.body,
                                { color: palette.textMuted },
                            ]}
                        >
                            @
                        </Text>
                    </View>
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
        </SafeAreaView>
        </KeyboardAvoidingView>
        <View
            style={[
                styles.footer,
                {
                    bottom: keyboardOpen
                        ? keyboardHeight + spacing.md
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
        </View>
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
        // Content input — clearly rounded but not a pill (search bars
        // use radius.full to read as their own object class).
        borderRadius: radius.md,
        borderWidth: 1,
        marginTop: spacing.md,
    },
    atContainer: {
        // Full-height absolute overlay. justifyContent: 'center'
        // vertically centres the @ glyph regardless of the input's
        // internal padding quirks (which were causing the baseline
        // mismatch when @ was a flex sibling).
        position: 'absolute',
        left: spacing.md,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        // Taps fall through to the TextInput so the user can tap
        // anywhere in the input area, including on top of the @.
        pointerEvents: 'none',
    },
    input: {
        flex: 1,
        height: '100%',
        // Reserve space for the @ overlay. At fontSize 16 the @ glyph
        // is ~12px wide; 14 gives a ~2px gap that matches natural
        // inter-character spacing so "@paul" reads as one unit.
        paddingLeft: 14,
        // iOS TextInput's default vertical text placement sits slightly
        // below the @ overlay's optical centre. paddingBottom adds
        // space *below* the rendered text, biasing it upward inside
        // the 48-tall row so the typed glyph baselines line up with
        // the @ baseline. Tune this value if the seam still reads off
        // — higher = more upward shift.
        paddingBottom: 4,
    },
    footer: {
        // Absolutely positioned so the Continue button snaps to the
        // top edge of the keyboard the moment keyboardWillShow fires,
        // instead of sliding up alongside it. `bottom` is set inline:
        // keyboardHeight + spacing.md when open, insets.bottom + md
        // when closed.
        position: 'absolute',
        left: spacing.base,
        right: spacing.base,
        gap: spacing.sm,
    },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
