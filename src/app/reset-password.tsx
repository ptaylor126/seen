/**
 * Set-new-password screen — the route +native-intent steers seen://auth/reset
 * to, and useAuthLink router.replace's to after exchanging the recovery
 * link's PKCE code. By the time this mounts via that path, a RECOVERY
 * SESSION exists (the exchange IS a sign-in); the password update runs
 * under it via supabase.auth.updateUser.
 *
 * Root-route (not in the (auth) group) on purpose: the root layout's
 * routing effect only redirects signed-in users OUT of (auth)/(onboarding),
 * so a signed-in recovery user can sit here without being bounced to tabs.
 * Flip side: a signed-OUT visitor gets replaced to /(auth)/sign-in by that
 * same effect — which is fine, that's a stronger version of this screen's
 * own no-session guard (never show a dead password form).
 *
 * Abandon handling (the security property): a recovery link signs the user
 * in BEFORE any password is set. If they leave this screen without
 * updating (Cancel, or any navigation away), the recovery session is
 * SIGNED OUT — link possession alone must not become a persistent
 * signed-in session that bypasses the password gate. Best-effort by
 * nature: a force-kill skips JS cleanup and the persisted session
 * survives until next launch; every in-app path out of the screen is
 * covered. Arrivals WITHOUT ?via=recovery (a normally signed-in user
 * wandering in) are exempt — signing them out would be hostile; for them
 * this is just a password-change form and Cancel simply leaves.
 *
 * The password lives only in this component's state, goes only to
 * updatePassword → supabase.auth, and is never logged or attached to any
 * error (errors render from a static copy table keyed by code).
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CaretLeft, Eye, EyeSlash } from 'phosphor-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text } from '@/components/text';
import { TextInput } from '@/components/text-input';
import { useProfile } from '@/hooks/use-profile';
import {
    signOut,
    updatePassword,
    type UpdatePasswordResult,
} from '@/lib/auth';
import { setRecoveryIntent } from '@/lib/recovery-intent';
import supabase from '@/lib/supabase';
import { button, getPalette, radius, spacing, typography } from '@/theme/theme';

// Mirrors the email screen (Supabase project default; UX-only — the server
// enforces the real rule).
const MIN_PASSWORD_LENGTH = 6;
// Matches the email screen's submit pill / the sign-in social buttons.
const BUTTON_WIDTH = 280;

type UpdateError = Extract<UpdatePasswordResult, { ok: false }>['error'];

const ERROR_COPY: Record<UpdateError, string> = {
    same_password: 'New password must be different from your old one.',
    weak_password: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    generic: 'Something went wrong. Please try again.',
};

export default function ResetPasswordScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    // Set by useAuthLink when it routes here after a recovery-code
    // exchange. Only recovery arrivals get the abandon-sign-out treatment.
    const { via } = useLocalSearchParams<{ via?: string }>();
    const isRecovery = via === 'recovery';
    const { refresh: refreshProfile } = useProfile();

    // 'checking' = session probe in flight; 'invalid' = no session (never
    // show a dead form); 'form' = recovery session present, show the form.
    const [phase, setPhase] = useState<'checking' | 'invalid' | 'form'>(
        'checking',
    );
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<UpdateError | null>(null);

    // Refs, not state, because the unmount cleanup below must read the
    // FINAL values, not the ones captured at mount.
    const completedRef = useRef(false);
    const hadSessionRef = useRef(false);
    const signOutFiredRef = useRef(false);

    // Guard: confirm a session actually exists before showing the form.
    // Reached without a valid exchange (expired code → useAuthLink routes
    // to the email screen's link-error state instead, but guard anyway),
    // there is nothing this form could do — updateUser has no session to
    // act on.
    useEffect(() => {
        let active = true;
        void supabase.auth.getSession().then(
            ({ data: { session } }) => {
                if (!active) return;
                hadSessionRef.current = !!session;
                setPhase(session ? 'form' : 'invalid');
            },
            () => {
                if (active) setPhase('invalid');
            },
        );
        return () => {
            active = false;
        };
    }, []);

    async function abandonRecoverySession() {
        if (signOutFiredRef.current) return;
        signOutFiredRef.current = true;
        // Intent down FIRST so a later normal sign-in can never be
        // misrouted here by a stale flag, even if the sign-out below
        // fails.
        setRecoveryIntent(false);
        try {
            await signOut();
            // Session gone → the root routing effect lands on sign-in.
        } catch (err) {
            console.warn('recovery abandon sign-out failed:', err);
        }
    }

    // Abandon net: ANY route away from a recovery arrival without a
    // completed update (Cancel already signed out — the ref guard makes
    // this a no-op then; hardware back / gesture / a stray navigation all
    // land here).
    useEffect(() => {
        return () => {
            if (isRecovery && hadSessionRef.current && !completedRef.current) {
                void abandonRecoverySession();
            }
        };
        // isRecovery comes from the arrival params and never changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
    const canSubmit = passwordValid && !busy && phase === 'form';
    const passwordCaption =
        password.length > 0 && !passwordValid
            ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
            : null;

    function handleCancel() {
        if (isRecovery && hadSessionRef.current && !completedRef.current) {
            // Leaving without setting a password: drop the recovery
            // session (see header). Routing effect takes over from there.
            void abandonRecoverySession();
            return;
        }
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/(tabs)');
        }
    }

    async function handleSubmit() {
        if (!canSubmit) return;
        setBusy(true);
        setFormError(null);
        const result = await updatePassword(password);
        setBusy(false);
        if (!result.ok) {
            setFormError(result.error);
            return;
        }
        completedRef.current = true;
        // The recovery session is now a normal signed-in session with the
        // new password behind it: intent down (root routing resumes normal
        // rules), profile hydration kicked off (ProfileProvider doesn't
        // refresh on the recovery flow's auth events, so without this,
        // tabs would mount with a null profile). Fire-and-forget: refresh
        // retries internally, and the success alert + tabs mount give it
        // time; blocking the success path on it could hang the button on
        // a flaky network.
        setRecoveryIntent(false);
        void refreshProfile();
        // Route via tabs; the root effect corrects to onboarding if this
        // account never finished it.
        Alert.alert(
            'Password updated',
            "You're signed in with your new password.",
            [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
            { cancelable: false },
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
                    <View style={styles.header}>
                        <Pressable
                            onPress={handleCancel}
                            hitSlop={spacing.sm}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <CaretLeft color={palette.accent} size={28} />
                        </Pressable>
                    </View>

                    {phase === 'checking' ? (
                        <View style={styles.centerFill}>
                            <ActivityIndicator color={palette.accent} />
                        </View>
                    ) : phase === 'invalid' ? (
                        <View style={styles.body}>
                            <Text
                                style={[typography.display, { color: palette.text }]}
                            >
                                Reset link not valid
                            </Text>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.textMuted },
                                ]}
                            >
                                This reset link is invalid or has expired.
                                Request a new one to keep going.
                            </Text>
                            <Pressable
                                onPress={() =>
                                    router.replace({
                                        pathname: '/(auth)/email',
                                        params: { forgot: '1' },
                                    })
                                }
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                style={({ pressed }) => [
                                    styles.quietAction,
                                    { opacity: pressed ? 0.6 : 1 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Request a new link
                                </Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View style={styles.body}>
                            <Text
                                style={[typography.display, { color: palette.text }]}
                            >
                                Set a new password
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
                                    value={password}
                                    onChangeText={(t) => {
                                        setPassword(t);
                                        if (formError) setFormError(null);
                                    }}
                                    placeholder="New password"
                                    placeholderTextColor={palette.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    secureTextEntry={!showPassword}
                                    autoComplete="new-password"
                                    textContentType="newPassword"
                                    autoFocus
                                    editable={!busy}
                                    returnKeyType="go"
                                    onSubmitEditing={handleSubmit}
                                    style={[
                                        styles.input,
                                        typography.body,
                                        { color: palette.text },
                                    ]}
                                />
                                <Pressable
                                    onPress={() => setShowPassword((v) => !v)}
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    accessibilityLabel={
                                        showPassword ? 'Hide password' : 'Show password'
                                    }
                                    style={({ pressed }) => [
                                        pressed && { opacity: 0.6 },
                                    ]}
                                >
                                    {showPassword ? (
                                        <EyeSlash color={palette.textMuted} size={20} />
                                    ) : (
                                        <Eye color={palette.textMuted} size={20} />
                                    )}
                                </Pressable>
                            </View>
                            {passwordCaption ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {passwordCaption}
                                </Text>
                            ) : null}

                            {formError ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.error },
                                    ]}
                                >
                                    {ERROR_COPY[formError]}
                                </Text>
                            ) : null}

                            <Pressable
                                onPress={handleSubmit}
                                disabled={!canSubmit}
                                style={({ pressed }) => [
                                    styles.submitButton,
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
                                        Update password
                                    </Text>
                                )}
                            </Pressable>
                        </View>
                    )}
                </SafeAreaView>
            </KeyboardAvoidingView>
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
    centerFill: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Same content-input shape as the email screen / onboarding handle
    // step: surface fill, hairline border, md radius.
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        height: 48,
        borderRadius: radius.md,
        borderWidth: 1,
    },
    input: {
        flex: 1,
        height: '100%',
    },
    submitButton: {
        width: BUTTON_WIDTH,
        alignSelf: 'center',
        marginTop: spacing.md,
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    quietAction: {
        marginTop: spacing.sm,
    },
});
