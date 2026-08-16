/**
 * Auth helpers.
 *
 * Native social providers — Sign in with Apple (iOS only) and Google
 * Sign-In (Android and iOS). Both flows obtain an identity token from the
 * provider client-side, then exchange it via Supabase's `signInWithIdToken`
 * so the resulting session is bound to a single `auth.users` row
 * regardless of provider. Email/password lives below them.
 *
 * The Supabase client (src/lib/supabase.ts) is configured to persist
 * sessions via AsyncStorage, so subsequent launches restore the session
 * without re-prompting.
 */
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';

import { cleanupPushOnSignOut } from './push';
import supabase from './supabase';

// Configure Google Sign-In once at module load. The iOS Client ID is the
// one paired with `com.paultaylor.seen` in Google Cloud. The Web Client ID
// serves double duty: Supabase's Google provider verifies idTokens against
// it server-side, AND Android needs it here as webClientId to mint that
// idToken in the first place (without it, Android sign-in fails with
// DEVELOPER_ERROR). Client IDs are public identifiers, safe in the bundle.
GoogleSignin.configure({
    iosClientId: '555711294328-a8bq6p5ot1nrpinkdr5k99c5u7en7ntn.apps.googleusercontent.com',
    webClientId: '555711294328-8bn16cvj0bi3htgdqsk0ijgler4u526e.apps.googleusercontent.com',
});

export async function signInWithApple(): Promise<void> {
    const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
    });

    const { identityToken } = credential;
    if (!identityToken) {
        throw new Error('Apple sign-in succeeded but no identity token was returned.');
    }

    const { error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: identityToken,
    });

    if (error) throw error;
}

// Used by BOTH platforms' Google buttons. hasPlayServices() is an
// Android-shaped check but iOS-safe: the library short-circuits it to
// `return true` on iOS before touching the native module (verified in
// GoogleSignin.js), so no platform guard is needed here.
export async function signInWithGoogle(): Promise<void> {
    await GoogleSignin.hasPlayServices();
    await GoogleSignin.signIn();
    const tokens = await GoogleSignin.getTokens();

    if (!tokens.idToken) {
        throw new Error('Google sign-in succeeded but no idToken was returned.');
    }

    const { error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: tokens.idToken,
    });

    if (error) throw error;
}

// ---------------------------------------------------------------------------
// Email/password. Confirm-email is ON in the Supabase project, which shapes
// both helpers:
//   - signUp returns NO session — the user must tap the verification link
//     (seen://auth/callback, handled in the auth-link stage) before they can
//     sign in. The UI holds them on a "check your email" state.
//   - An unconfirmed user trying to sign IN gets a distinct
//     'email_not_confirmed' result, never a misleading "wrong password".
// Results are discriminated unions (same shape as the claim helpers in
// pending-recs.ts) so screens branch on stable codes, not on raw Postgrest/
// GoTrue message strings.
// ---------------------------------------------------------------------------

const EMAIL_VERIFY_REDIRECT = 'seen://auth/callback';

export type EmailSignUpResult =
    | { ok: true; verificationSentTo: string }
    | { ok: false; error: 'already_registered' | 'generic' };

export async function signUpWithEmail(
    email: string,
    password: string,
): Promise<EmailSignUpResult> {
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: EMAIL_VERIFY_REDIRECT },
    });
    if (error) {
        // user_already_exists is the explicit server code; the message
        // match is a fallback for older gateway variants.
        if (
            error.code === 'user_already_exists' ||
            /already registered/i.test(error.message ?? '')
        ) {
            return { ok: false, error: 'already_registered' };
        }
        console.error('email sign-up failed:', error);
        return { ok: false, error: 'generic' };
    }
    // With confirm-email ON, GoTrue deliberately does NOT error when the
    // email already has an account — via ANY provider; live probes showed
    // the response is identical for a Google-only account and an
    // email/password account (anti-enumeration): a fake user whose
    // identities array is EMPTY, and no email is sent. This guard is the
    // documented detection for that — but it is DEAD on the installed
    // auth-js (its transform maps the obfuscated top-level user to null,
    // so data.user is null here for fresh AND collision signups alike).
    // Kept because it's harmless and fires on lib versions where
    // data.user survives; the product-level answer is detection-free
    // guidance instead (the unconditional "already have an account?"
    // lines on the check-your-email state and the sign-in error).
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
        return { ok: false, error: 'already_registered' };
    }
    return { ok: true, verificationSentTo: email };
}

export type EmailSignInResult =
    | { ok: true }
    | {
          ok: false;
          error: 'wrong_credentials' | 'email_not_confirmed' | 'generic';
      };

export async function signInWithEmail(
    email: string,
    password: string,
): Promise<EmailSignInResult> {
    const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });
    if (!error) return { ok: true };
    // Unconfirmed FIRST: GoTrue reports it distinctly, and telling this
    // user "wrong password" would send them to a reset loop instead of
    // their inbox.
    if (
        error.code === 'email_not_confirmed' ||
        /not confirmed/i.test(error.message ?? '')
    ) {
        return { ok: false, error: 'email_not_confirmed' };
    }
    if (
        error.code === 'invalid_credentials' ||
        /invalid login credentials/i.test(error.message ?? '')
    ) {
        return { ok: false, error: 'wrong_credentials' };
    }
    console.error('email sign-in failed:', error);
    return { ok: false, error: 'generic' };
}

// Re-send the signup verification email (the "check your email" state's
// resend affordance). Same redirect as the original send.
export async function resendVerificationEmail(
    email: string,
): Promise<boolean> {
    const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: EMAIL_VERIFY_REDIRECT },
    });
    if (error) {
        console.error('verification resend failed:', error);
        return false;
    }
    return true;
}

// Password reset, request side. GoTrue deliberately returns success for
// an email with NO account (anti-enumeration), so the boolean carries no
// account-existence signal — false means rate limit / network only, and
// the UI shows an unconditional "check your email" ack either way. The
// redirect uses the seen:// scheme (works on every shipped binary);
// useAuthLink exchanges the code and routes to /reset-password.
const RESET_REDIRECT = 'seen://auth/reset';

export async function requestPasswordReset(email: string): Promise<boolean> {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: RESET_REDIRECT,
    });
    if (error) {
        console.error('password reset request failed:', error);
        return false;
    }
    return true;
}

export type UpdatePasswordResult =
    | { ok: true }
    | { ok: false; error: 'same_password' | 'weak_password' | 'generic' };

// Sets a new password for the CURRENT session — on /reset-password that is
// the recovery session useAuthLink's code exchange established. The only
// place the app ever sets a password; the value goes straight to
// supabase.auth over HTTPS and is never logged or stored.
export async function updatePassword(
    newPassword: string,
): Promise<UpdatePasswordResult> {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (!error) return { ok: true };
    if (
        error.code === 'same_password' ||
        /different from the old/i.test(error.message ?? '')
    ) {
        return { ok: false, error: 'same_password' };
    }
    if (
        error.code === 'weak_password' ||
        /at least/i.test(error.message ?? '')
    ) {
        return { ok: false, error: 'weak_password' };
    }
    console.error('password update failed:', error);
    return { ok: false, error: 'generic' };
}

export async function signOut(): Promise<void> {
    // Shared-device hygiene BEFORE the session is cleared: delete this
    // device's push_tokens rows (RLS is owner-only, so this is only
    // authorised while still signed in), reset the launch-registration
    // flag, and zero the app-icon badge — so the next account on this
    // device neither receives the outgoing user's pushes nor sees their
    // badge count. Best-effort: cleanup failure must never block the
    // sign-out itself (e.g. post-account-deletion, where the server has
    // already wiped push_tokens and this delete is a harmless no-op).
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        if (session?.user.id) {
            await cleanupPushOnSignOut(session.user.id);
        }
    } catch (err) {
        console.warn('sign-out cleanup failed (continuing to sign out):', err);
    }

    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}
