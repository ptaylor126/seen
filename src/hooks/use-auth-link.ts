import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { setRecoveryIntent } from '@/lib/recovery-intent';
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

        // Recovery intent goes up BEFORE the exchange (reset URLs only —
        // never verification/callback): root routing must never see a
        // frame where the recovery session exists without knowing it's a
        // recovery, or it would race the user into a profile-dependent
        // screen. Cleared on every terminal path: both failure branches
        // below, the reset screen's completion, and its abandon sign-out.
        if (isReset) setRecoveryIntent(true);

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
                setRecoveryIntent(false); // no session is coming
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
                setRecoveryIntent(false); // no session materialised
                routeToEmailWithLinkError();
                return;
            }

            // Exchange succeeded — the session is now set and persisted
            // through the singleton client's normal path, and this hook
            // does NO navigation for either flavour:
            //   - verification/callback: onAuthStateChange fires and the
            //     root routing effect sends the fresh user to onboarding,
            //     exactly as after a social sign-in (unchanged);
            //   - reset: the recovery intent raised above makes the root
            //     routing effect route to /reset-password?via=recovery —
            //     the reset screen is the deterministic destination, not
            //     a race winner.
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
