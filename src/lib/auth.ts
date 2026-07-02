/**
 * Auth helpers.
 *
 * Two native providers — Sign in with Apple on iOS, Google Sign-In on
 * Android (and iOS once an Android EAS build is wired up). Both flows
 * obtain an identity token from the provider client-side, then exchange it
 * via Supabase's `signInWithIdToken` so the resulting session is bound to
 * a single `auth.users` row regardless of provider.
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
// is NOT needed here — that one lives in the Supabase Google provider
// config and is used to verify the identity token server-side.
GoogleSignin.configure({
    iosClientId: '555711294328-a8bq6p5ot1nrpinkdr5k99c5u7en7ntn.apps.googleusercontent.com',
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
