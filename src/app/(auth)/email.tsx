/**
 * Email/password sign-in and sign-up.
 *
 * Reached from the quiet "Continue with email" line on the sign-in screen;
 * the social buttons stay the primary path. One route, three states:
 *
 *   mode 'sign-in'  — email + password → signInWithEmail. Success does
 *                     NOTHING here: onAuthStateChange fires and the root
 *                     layout's routing effect takes over, exactly as it
 *                     does for the social providers.
 *   mode 'sign-up'  — email + password → signUpWithEmail. Confirm-email is
 *                     ON in Supabase, so success returns NO session; the
 *                     screen switches to the check-your-email state.
 *   sent            — holding state after sign-up: the verification link
 *                     must be tapped before the account can sign in.
 *   forgot          — password-reset request: email only →
 *                     requestPasswordReset, then an unconditional
 *                     check-your-email ack (anti-enumeration: shown whether
 *                     or not the email has an account). The link itself is
 *                     handled by useAuthLink → /reset-password.
 *
 * Client-side validation (email shape, password ≥ 6) is UX ONLY — it
 * exists to catch typos before a round-trip. The enforced rules live in
 * Supabase (GoTrue rejects bad emails and short passwords server-side);
 * nothing here is a security boundary. The password lives only in this
 * component's state and is passed only to the supabase.auth helpers; it is
 * never logged, stored, or attached to error state.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CaretLeft, EnvelopeSimple, Eye, EyeSlash } from 'phosphor-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text } from '@/components/text';
import { TextInput } from '@/components/text-input';
import { useToast } from '@/components/toast';
import {
    requestPasswordReset,
    resendVerificationEmail,
    signInWithEmail,
    signUpWithEmail,
    type EmailSignInResult,
    type EmailSignUpResult,
} from '@/lib/auth';
import { button, getPalette, radius, spacing, typography } from '@/theme/theme';

// UX-only shape check (see header). Deliberately loose: anything with a
// non-space local part, an @, and a dotted domain. GoTrue does the real
// validation server-side.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Supabase project default minimum. If the dashboard setting ever changes,
// update this to match — a mismatch just means the server catches what the
// client didn't, with a less friendly message.
const MIN_PASSWORD_LENGTH = 6;
// Client-side resend cooldown. This is UX (stops accidental double-taps),
// NOT rate limiting — Supabase enforces its own server-side email rate
// limits regardless of what this client does.
const RESEND_COOLDOWN_MS = 30_000;

// Matches the social buttons on the sign-in screen so the primary action
// reads as the same object class across both screens.
const BUTTON_WIDTH = 280;

type Mode = 'sign-in' | 'sign-up';
type FormError =
    | Extract<EmailSignUpResult, { ok: false }>['error']
    | Extract<EmailSignInResult, { ok: false }>['error'];

const ERROR_COPY: Record<FormError, string> = {
    // Deliberately combined ("email or password") — splitting it would
    // reveal which emails have accounts (enumeration).
    wrong_credentials: 'Wrong email or password.',
    email_not_confirmed:
        "That email hasn't been verified yet. Check your inbox for the link.",
    // Unreachable in practice — sign-up collisions convert to the
    // sign-in-mode switch + notice below — kept for the Record type.
    already_registered: 'That email already has an account. Sign in instead.',
    generic: 'Something went wrong. Please try again.',
};

// Shown under "Wrong email or password." on every sign-in failure. A
// Google/Apple-only account produces the exact same invalid_credentials
// error as a typo'd password (verified by live probe), so this hint is
// shown to EVERYONE — it confirms nothing about the account and names no
// provider the email actually uses, so there is no enumeration leak; it
// just rescues the social-only user from a dead end.
const SOCIAL_HINT_SIGN_IN =
    'If you signed up with Google or Apple, go back and use those buttons to sign in.';

// Shown if signUpWithEmail ever reports already_registered. In practice
// that detection is dead on the installed auth-js (see the guard's
// comment in lib/auth.ts) — the working, detection-free guidance is
// SENT_STATE_HINT below plus SOCIAL_HINT_SIGN_IN — but the branch stays
// wired for lib versions where the signal survives.
const COLLISION_NOTICE =
    'An account with this email may already exist. Try signing in below, or use Google or Apple if you signed up that way.';

// Unconditional second path on the check-your-email state. Every
// successful-LOOKING signUp lands there — genuine new signups AND silent
// collisions (Supabase's anti-enumeration fake success sends no email for
// an already-registered address, via any provider). The screen genuinely
// cannot tell which case it is, so the body copy hedges ("If this email
// is new…") and this line is a peer alternative, not fine print. Shown to
// everyone, so it reveals nothing about this email.
const SENT_STATE_HINT =
    'Already have an account? Go back to sign in, or use Google or Apple.';

export default function EmailAuthScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { showToast, toast } = useToast();

    // Set by useAuthLink when a verification/reset link's code exchange
    // failed (expired or already used). Shown as a banner until the user
    // does anything; sign-in mode (the default) closes the loop — an
    // unconfirmed user signing in hits email_not_confirmed, whose resend
    // affordance issues a fresh link.
    const { linkError, forgot } = useLocalSearchParams<{
        linkError?: string;
        forgot?: string;
    }>();
    const [showLinkError, setShowLinkError] = useState(false);
    useEffect(() => {
        if (linkError) setShowLinkError(true);
    }, [linkError]);

    // Password-reset request state. forgotMode swaps the form for the
    // email-only request; resetSentTo (non-null) is the unconditional
    // "check your email" ack. Openable via param too — the reset screen's
    // invalid-link state routes here with forgot=1.
    const [forgotMode, setForgotMode] = useState(false);
    const [resetSentTo, setResetSentTo] = useState<string | null>(null);
    useEffect(() => {
        if (forgot) setForgotMode(true);
    }, [forgot]);

    const [mode, setMode] = useState<Mode>('sign-in');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<FormError | null>(null);
    // Sign-up collision guidance (see COLLISION_NOTICE). Set alongside the
    // programmatic switch to sign-in mode so the user understands why the
    // form changed under them.
    const [collisionNotice, setCollisionNotice] = useState(false);
    // Non-null = the check-your-email state, holding the address the
    // verification link went to.
    const [sentTo, setSentTo] = useState<string | null>(null);

    const [resendBusy, setResendBusy] = useState(false);
    const [resendCoolingDown, setResendCoolingDown] = useState(false);
    const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        return () => {
            if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
        };
    }, []);

    const trimmedEmail = email.trim();
    const emailValid = EMAIL_RE.test(trimmedEmail);
    const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
    const canSubmit = emailValid && passwordValid && !busy;

    // Inline captions follow the handle screen's rule: only complain once
    // the user has typed something in that field.
    const emailCaption =
        email.length > 0 && !emailValid
            ? "That doesn't look like an email address."
            : null;
    const passwordCaption =
        password.length > 0 && !passwordValid
            ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
            : null;

    function switchMode() {
        setMode((m) => (m === 'sign-in' ? 'sign-up' : 'sign-in'));
        setFormError(null);
        setShowLinkError(false);
        setCollisionNotice(false);
    }

    async function handleSubmit() {
        if (!canSubmit) return;
        setBusy(true);
        setFormError(null);
        try {
            if (mode === 'sign-up') {
                const result = await signUpWithEmail(trimmedEmail, password);
                if (result.ok) {
                    setSentTo(result.verificationSentTo);
                } else if (result.error === 'already_registered') {
                    // The email is registered via some method (Supabase
                    // won't say which — see COLLISION_NOTICE). Switch to
                    // sign-in with the email preserved so they can just
                    // proceed, plus the notice so the switch isn't silent.
                    setMode('sign-in');
                    setCollisionNotice(true);
                } else {
                    setFormError(result.error);
                }
            } else {
                const result = await signInWithEmail(trimmedEmail, password);
                if (!result.ok) {
                    setFormError(result.error);
                }
                // Success: no navigation. The session lands via
                // onAuthStateChange and the root layout routes, same as
                // the social sign-ins.
            }
        } finally {
            setBusy(false);
        }
    }

    async function handleResend() {
        if (resendBusy || resendCoolingDown) return;
        setResendBusy(true);
        const ok = await resendVerificationEmail(sentTo ?? trimmedEmail);
        setResendBusy(false);
        if (ok) {
            showToast('Verification email sent.');
            startResendCooldown();
        } else {
            showToast("Couldn't resend. Try again.");
        }
    }

    function startResendCooldown() {
        setResendCoolingDown(true);
        if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
        cooldownTimer.current = setTimeout(() => {
            setResendCoolingDown(false);
            cooldownTimer.current = null;
        }, RESEND_COOLDOWN_MS);
    }

    // Reset-request submit AND its ack-state resend (same call both times;
    // the shared cooldown is fine — the two flows are never live at once).
    // ok=false is rate limit / network ONLY (the helper's contract): GoTrue
    // fake-succeeds for unknown emails, so nothing here can leak account
    // existence — the ack shows unconditionally on success.
    async function handleSendReset() {
        if (!emailValid || busy || resendBusy || resendCoolingDown) return;
        const isResend = resetSentTo !== null;
        setBusy(true);
        const ok = await requestPasswordReset(trimmedEmail);
        setBusy(false);
        if (ok) {
            setResetSentTo(trimmedEmail);
            if (isResend) {
                showToast('Reset email sent.');
                startResendCooldown();
            }
        } else {
            showToast("Couldn't send the email. Try again.");
        }
    }

    const resendDisabled = resendBusy || resendCoolingDown;

    return (
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
                    <View style={styles.header}>
                        <Pressable
                            onPress={() => router.back()}
                            hitSlop={spacing.sm}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <CaretLeft color={palette.accent} size={28} />
                        </Pressable>
                    </View>

                    {sentTo ? (
                        <View style={styles.sentBody}>
                            <EnvelopeSimple color={palette.accent} size={48} />
                            <Text
                                style={[
                                    typography.display,
                                    styles.centeredText,
                                    { color: palette.text },
                                ]}
                            >
                                Check your email
                            </Text>
                            <Text
                                style={[
                                    typography.body,
                                    styles.centeredText,
                                    { color: palette.textMuted },
                                ]}
                            >
                                If this email is new, we've sent a
                                verification link to{' '}
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                >
                                    {sentTo}
                                </Text>
                                . Tap it to finish setting up your account.
                            </Text>
                            <Pressable
                                onPress={handleResend}
                                disabled={resendDisabled}
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                style={({ pressed }) => [
                                    styles.quietAction,
                                    { opacity: resendDisabled ? 0.4 : pressed ? 0.6 : 1 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Resend email
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={() => setSentTo(null)}
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
                                    Use a different email
                                </Text>
                            </Pressable>
                            <Text
                                style={[
                                    // Body size at textMuted: peer weight
                                    // with the copy above it, clearly
                                    // subordinate to the accent actions,
                                    // and nothing like an error.
                                    typography.body,
                                    styles.centeredText,
                                    styles.sentAlternative,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {SENT_STATE_HINT}
                            </Text>
                        </View>
                    ) : resetSentTo ? (
                        <View style={styles.sentBody}>
                            <EnvelopeSimple color={palette.accent} size={48} />
                            <Text
                                style={[
                                    typography.display,
                                    styles.centeredText,
                                    { color: palette.text },
                                ]}
                            >
                                Check your email
                            </Text>
                            {/* Hedged like the signup ack (anti-enumeration:
                                identical whether or not the email has an
                                account), plus the PKCE device caveat — the
                                code only exchanges against the verifier
                                stored on the device that requested it. */}
                            <Text
                                style={[
                                    typography.body,
                                    styles.centeredText,
                                    { color: palette.textMuted },
                                ]}
                            >
                                If an account exists for{' '}
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                >
                                    {resetSentTo}
                                </Text>
                                , we've sent a password reset link. Open the
                                link on this device to reset your password.
                            </Text>
                            <Pressable
                                onPress={handleSendReset}
                                disabled={resendDisabled || busy}
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                style={({ pressed }) => [
                                    styles.quietAction,
                                    {
                                        opacity:
                                            resendDisabled || busy
                                                ? 0.4
                                                : pressed
                                                  ? 0.6
                                                  : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Resend email
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={() => {
                                    setResetSentTo(null);
                                    setForgotMode(false);
                                }}
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
                                    Back to sign in
                                </Text>
                            </Pressable>
                        </View>
                    ) : forgotMode ? (
                        <View style={styles.body}>
                            <Text
                                style={[typography.display, { color: palette.text }]}
                            >
                                Reset your password
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
                                    value={email}
                                    onChangeText={setEmail}
                                    placeholder="Email"
                                    placeholderTextColor={palette.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    keyboardType="email-address"
                                    autoComplete="email"
                                    textContentType="emailAddress"
                                    editable={!busy}
                                    returnKeyType="go"
                                    onSubmitEditing={handleSendReset}
                                    style={[
                                        styles.input,
                                        typography.body,
                                        { color: palette.text },
                                    ]}
                                />
                            </View>
                            {emailCaption ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {emailCaption}
                                </Text>
                            ) : null}

                            <Pressable
                                onPress={handleSendReset}
                                disabled={!emailValid || busy}
                                style={({ pressed }) => [
                                    styles.submitButton,
                                    {
                                        backgroundColor: palette.accent,
                                        opacity:
                                            !emailValid || busy
                                                ? 0.4
                                                : pressed
                                                  ? 0.6
                                                  : 1,
                                    },
                                ]}
                            >
                                {busy ? (
                                    <ActivityIndicator color={palette.textInverse} />
                                ) : (
                                    <Text
                                        style={[
                                            typography.bodyEmphasis,
                                            styles.centeredText,
                                            { color: palette.textInverse },
                                        ]}
                                    >
                                        Send reset link
                                    </Text>
                                )}
                            </Pressable>

                            <Pressable
                                onPress={() => setForgotMode(false)}
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                style={({ pressed }) => [
                                    styles.modeToggle,
                                    { opacity: pressed ? 0.6 : 1 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Back to sign in
                                </Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View style={styles.body}>
                            <Text
                                style={[typography.display, { color: palette.text }]}
                            >
                                {mode === 'sign-in' ? 'Sign in' : 'Create an account'}
                            </Text>

                            {showLinkError ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.error },
                                    ]}
                                >
                                    That link has expired or was already used.
                                    Sign in to continue.
                                </Text>
                            ) : null}
                            {collisionNotice ? (
                                // Guidance, not an alarm — textMuted, not
                                // the error colour.
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {COLLISION_NOTICE}
                                </Text>
                            ) : null}

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
                                    value={email}
                                    onChangeText={(t) => {
                                        setEmail(t);
                                        if (formError) setFormError(null);
                                        if (showLinkError) setShowLinkError(false);
                                        if (collisionNotice) setCollisionNotice(false);
                                    }}
                                    placeholder="Email"
                                    placeholderTextColor={palette.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    keyboardType="email-address"
                                    autoComplete="email"
                                    textContentType="emailAddress"
                                    editable={!busy}
                                    returnKeyType="next"
                                    style={[
                                        styles.input,
                                        typography.body,
                                        { color: palette.text },
                                    ]}
                                />
                            </View>
                            {emailCaption ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {emailCaption}
                                </Text>
                            ) : null}

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
                                        if (showLinkError) setShowLinkError(false);
                                    }}
                                    placeholder="Password"
                                    placeholderTextColor={palette.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    secureTextEntry={!showPassword}
                                    autoComplete={
                                        mode === 'sign-up'
                                            ? 'new-password'
                                            : 'current-password'
                                    }
                                    textContentType={
                                        mode === 'sign-up' ? 'newPassword' : 'password'
                                    }
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
                                        styles.errorCaption,
                                        { color: palette.error },
                                    ]}
                                >
                                    {ERROR_COPY[formError]}
                                </Text>
                            ) : null}
                            {formError === 'wrong_credentials' ? (
                                // Quiet secondary line, shown on EVERY
                                // credentials failure (see the constant's
                                // comment for the no-enumeration rationale).
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {SOCIAL_HINT_SIGN_IN}
                                </Text>
                            ) : null}
                            {formError === 'email_not_confirmed' ? (
                                <Pressable
                                    onPress={handleResend}
                                    disabled={resendDisabled}
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    style={({ pressed }) => [
                                        {
                                            opacity: resendDisabled
                                                ? 0.4
                                                : pressed
                                                  ? 0.6
                                                  : 1,
                                        },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        Resend verification email
                                    </Text>
                                </Pressable>
                            ) : null}
                            {mode === 'sign-in' ? (
                                // Always visible in sign-in mode, sitting
                                // right under the error slot so it reads as
                                // the way out of wrong_credentials. Opens
                                // the request state with the email carried
                                // over.
                                <Pressable
                                    onPress={() => {
                                        setForgotMode(true);
                                        setFormError(null);
                                        setShowLinkError(false);
                                        setCollisionNotice(false);
                                    }}
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    style={({ pressed }) => [
                                        pressed && { opacity: 0.6 },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        Forgot password?
                                    </Text>
                                </Pressable>
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
                                        {mode === 'sign-in'
                                            ? 'Sign in'
                                            : 'Create account'}
                                    </Text>
                                )}
                            </Pressable>

                            <Pressable
                                onPress={switchMode}
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                style={({ pressed }) => [
                                    styles.modeToggle,
                                    { opacity: pressed ? 0.6 : 1 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    {mode === 'sign-in'
                                        ? 'New here? Create an account'
                                        : 'Already have an account? Sign in'}
                                </Text>
                            </Pressable>
                        </View>
                    )}
                </SafeAreaView>
            </KeyboardAvoidingView>
            {toast}
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
    // The holding state centres its content — it's a landing card, not a
    // form, and the envelope + heading read better on the screen's axis.
    sentBody: {
        flex: 1,
        alignItems: 'center',
        gap: spacing.md,
        paddingTop: spacing.xl,
        paddingHorizontal: spacing.base,
    },
    centeredText: {
        textAlign: 'center',
    },
    // Same content-input shape as the onboarding handle screen: surface
    // fill, hairline border, md radius (rounded but not a pill — pills are
    // reserved for search bars and buttons).
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
    errorCaption: {
        marginTop: spacing.xs,
    },
    // Pill spec from the button token (V2: base padding + full radius),
    // at the social buttons' 280 width and centred to echo them.
    submitButton: {
        width: BUTTON_WIDTH,
        alignSelf: 'center',
        marginTop: spacing.md,
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeToggle: {
        alignSelf: 'center',
        marginTop: spacing.sm,
    },
    quietAction: {
        marginTop: spacing.sm,
    },
    // Separated from the resend/change-email stack so it reads as the
    // second PATH (the existing-account case the screen can't detect),
    // not a third action in that stack.
    sentAlternative: {
        marginTop: spacing.lg,
    },
});
