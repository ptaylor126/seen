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
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}
