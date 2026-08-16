import * as Linking from 'expo-linking';
import { router, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';

import supabase from '@/lib/supabase';
import { isAuthResetUrl, isAuthUrl } from '@/lib/url-kinds';

// Completes a Supabase auth deep link the app was opened with — the third
// subscriber on the shared useLinkingURL channel (siblings: useInviteLink,
// and the router itself via +native-intent). Disjoint-recogniser contract
// from url-kinds.ts: this hook acts ONLY on URLs isAuthUrl matches
// (seen://auth/…), so it can never fight the invite hook over a URL.
//
// Two shapes arrive here from GoTrue's /verify redirect:
//   success  seen://auth/callback?code={pkce-code}   (also …/reset?code=…)
//   failure  seen://auth/callback?error=access_denied&error_code=otp_expired&…
//            (an expired or already-used link never carries a code — GoTrue
//            reports the failure as redirect params instead)
//
// PKCE: the code is exchanged via exchangeCodeForSession, which pairs it
// with the code_verifier supabase-js stored at signUp time. Tokens are
// NEVER parsed out of the URL — with flowType 'pkce' there are none in it,
// and the code alone is useless without the locally-stored verifier.
//
// GATING — deliberately different from useInviteLink: a verification or
// reset link is used by a signed-OUT user by definition, so there is no
// auth/onboarding gate and no AsyncStorage stash (nothing to survive a
// mid-signup restart — the exchange IS the sign-in). Gate only on
// launchDone, for the same reason as the siblings: navigating before the
// launch overlay dismisses wedges its ready condition.
export function useAuthLink({ launchDone }: { launchDone: boolean }): void {
    // useLinkingURL, not the deprecated useURL — same device-tested channel
    // rationale as useInviteLink (see the comment there).
    const url = Linking.useLinkingURL();
    // Fire once per URL (the URL contains the code, so this is the
    // handledCode dedupe): the effect re-runs when launchDone flips while
    // the same retained URL is still current — exchange exactly once.
    const handledUrl = useRef<string | null>(null);

    useEffect(() => {
        if (!url || !isAuthUrl(url)) return; // not ours — siblings' problem
        if (!launchDone) return; // gate closed — retained URL fires later
        if (handledUrl.current === url) return;
        handledUrl.current = url;

        const isReset = isAuthResetUrl(url);
        const code = getParam(url, 'code');

        void (async () => {
            if (!code) {
                // GoTrue signalled failure via redirect params (expired /
                // already-used link). error_code (e.g. otp_expired) is a
                // public enum, safe to log; the URL carries no secrets in
                // this shape.
                console.warn(
                    'auth link arrived without a code:',
                    getParam(url, 'error_code') ??
                        getParam(url, 'error') ??
                        'no error param',
                );
                routeToEmailWithLinkError();
                return;
            }

            const { error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) {
                // Log the failure, never the code or any token. Covers a
                // code that expired between send and tap, was already
                // exchanged (link tapped twice), or a missing verifier
                // (link opened on a different device than the signup).
                console.warn('auth code exchange failed:', error.message);
                routeToEmailWithLinkError();
                return;
            }

            // Exchange succeeded — the session is now set and persisted
            // through the singleton client's normal path. For a
            // verification callback that is ALL this hook does: no manual
            // navigation, onAuthStateChange fires and the root layout's
            // routing effect sends the fresh user to onboarding, exactly
            // as it does after a social sign-in.
            if (isReset) {
                // Stage-5 seam: a recovery link must land on the
                // set-new-password screen, and the routing effect won't
                // fight this (it only redirects OUT of the auth/onboarding
                // groups). Until the screen exists, +not-found bounces to
                // (tabs) — safe, since the recovery exchange signed the
                // user in. The cast exists because typed routes don't know
                // the screen yet — remove it when stage 5 adds the route
                // file.
                router.replace('/reset-password' as Href);
            }
        })();
    }, [url, launchDone]);
}

// Query/fragment param extractor. GoTrue has emitted failure params in
// both positions across versions, so match after ? & or #. Values here are
// the PKCE code and public error enums — never tokens.
function getParam(url: string, name: string): string | null {
    const match = url.match(new RegExp(`[?&#]${name}=([^&#]+)`));
    return match ? decodeURIComponent(match[1]) : null;
}

// Expired/invalid link → the email screen with an explanatory banner
// (never a silent fail). Sign-in mode there closes the loop: an
// unconfirmed user signing in gets the email_not_confirmed error with its
// resend affordance, which issues a fresh link.
function routeToEmailWithLinkError(): void {
    router.push({ pathname: '/(auth)/email', params: { linkError: '1' } });
}
