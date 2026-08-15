import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import type { SessionState } from '@/hooks/use-session';
import {
    claimFriendInvite,
    claimPendingRec,
    parseInviteInput,
} from '@/lib/pending-recs';
import { goToProfile } from '@/lib/profile-nav';

// Claims an invite link the app was OPENED WITH, mirroring
// usePushNavigation (its sibling in RootLayoutInner): receive an external
// event, stash it, gate on auth + onboarding + launch, fire once, route.
//
// Two URL shapes reduce to the same { token, hint }:
//   scheme  seen://i?t={token}            (testable on the CURRENT binary
//           seen://r?t={token}             via `npx uri-scheme open`)
//   https   https://seenrecs.com/i/?t={token}
//           https://seenrecs.com/r/?t={token}   (dead until the
//           associatedDomains / intentFilters native config ships — this
//           hook is deliberately built ahead of it, OTA-able)
//
// Unlike push taps — which the OS retains via useLastNotificationResponse
// until superseded — an opening URL has no OS-retained equivalent, and the
// fresh-install path (tap link → install → sign up → onboard → claim) can
// restart the app between receipt and claim. So the parsed token persists
// in AsyncStorage, single-slot, newest intent wins.
const STASH_KEY = 'seen.invite.pending_token';

interface PendingInvite {
    token: string;
    hint: 'rec' | 'friend' | null;
}

// The scheme shape puts i/r in the HOST position (seen://i?t=…), which
// parseInviteInput's hint regexes — written for the https PATH shape
// (/i/?t=…) — don't match; the token would still parse via the bare-token
// fallback but the hint would be lost. Normalising the scheme URL to the
// path shape (rather than widening the parser) keeps parseInviteInput's
// behaviour byte-identical for its existing paste-flow callers.
function normalizeInviteUrl(url: string): string {
    const match = url.match(/^seen:\/\/(i|r)\/?(\?.*)?$/);
    if (match) {
        return `https://seenrecs.com/${match[1]}/${match[2] ?? ''}`;
    }
    return url;
}

function parseInviteUrl(url: string): PendingInvite | null {
    return parseInviteInput(normalizeInviteUrl(url));
}

async function clearStash(): Promise<void> {
    try {
        await AsyncStorage.removeItem(STASH_KEY);
    } catch {
        // Best-effort — a stale stash retries and hits the idempotent /
        // terminal handling again.
    }
}

// Handles an invite link the app was opened with. Mounted once in
// RootLayoutInner beside usePushNavigation (same signals in scope).
// Renders nothing.
//
// useLinkingURL() covers BOTH cold start (native-retained initial URL)
// and warm opens (onURLReceived events) — the same both-cases-one-hook
// shape the push hook gets from useLastNotificationResponse. The AsyncStorage stash adds what the OS
// doesn't give URLs: survival across an app restart mid-signup.
//
// Gate — claim only when (mirrors usePushNavigation exactly):
//   - authedOnboarded: signed in AND onboarded. The claim RPCs require
//     auth.uid(), and claiming mid-onboarding would fight the root
//     layout's routing effect; the stashed token simply waits and fires
//     the moment onboarding completes.
//   - launchDone: the launch overlay has dismissed — navigating earlier
//     pushes a route that un-satisfies the overlay's ready condition and
//     wedges it until its safety timeout (same reason as the push hook).
export function useInviteLink({
    session,
    profile,
    launchDone,
}: {
    session: SessionState;
    profile: { status: 'loading' | 'ready'; profile: { onboarded: boolean } | null };
    launchDone: boolean;
}): void {
    // useLinkingURL, NOT the deprecated useURL: useURL sits on RN core's
    // legacy Linking channel (getInitialURL + 'url' event), which the
    // 2026-08 device test showed never delivers the intent on this setup —
    // the router saw the URL, the hook logged null. useLinkingURL rides
    // expo-linking's own native module (getLinkingURL retained value +
    // onURLReceived event, dispatched straight from the Android activity
    // lifecycle listener's onNewIntent), the same native-retained-value +
    // native-event architecture that makes usePushNavigation reliable.
    const url = Linking.useLinkingURL();
    // undefined = AsyncStorage hydration still in flight; null = nothing
    // pending. Keeps the gate effect from racing the read on cold start.
    const [pending, setPending] = useState<PendingInvite | null | undefined>(
        undefined,
    );
    // De-dupe on the token: the effect re-runs whenever the gate signals
    // change while the same stash is still set — fire once per token per
    // session. (A generic/network failure keeps the stash but not the ref,
    // so the NEXT session retries; this one won't loop.)
    const handledToken = useRef<string | null>(null);

    // Hydrate any stash a previous session left behind (the restarted
    // fresh-install path).
    useEffect(() => {
        let active = true;
        void AsyncStorage.getItem(STASH_KEY).then(
            (raw) => {
                if (!active) return;
                if (!raw) {
                    setPending(null);
                    return;
                }
                try {
                    const parsed = JSON.parse(raw) as PendingInvite;
                    setPending(
                        typeof parsed?.token === 'string' ? parsed : null,
                    );
                } catch {
                    setPending(null);
                }
            },
            () => {
                if (active) setPending(null);
            },
        );
        return () => {
            active = false;
        };
    }, []);

    // Stash immediately on URL receipt, regardless of auth state — the
    // user may be about to spend minutes in sign-up + onboarding, or the
    // app may die in between. Single slot: a newer link overwrites an
    // older unclaimed one (newest intent wins).
    useEffect(() => {
        if (!url) return;
        const parsed = parseInviteUrl(url);
        if (!parsed) return; // not an invite link — expo-router's problem
        setPending(parsed);
        void AsyncStorage.setItem(STASH_KEY, JSON.stringify(parsed)).catch(
            () => {
                // In-memory `pending` still claims this session; only the
                // restart-survival is lost.
            },
        );
    }, [url]);

    const authedOnboarded =
        session.status === 'ready' &&
        !!session.session &&
        profile.status === 'ready' &&
        !!profile.profile?.onboarded;

    useEffect(() => {
        if (!pending) return; // nothing stashed (or hydration in flight)
        if (!authedOnboarded || !launchDone) return; // gate closed — wait

        if (handledToken.current === pending.token) return;
        handledToken.current = pending.token;

        const invite = pending;
        void (async () => {
            // Dispatch policy copied from ClaimInvite.handleClaim: /i/
            // hint → friend claim only; /r/ hint or bare token → rec
            // claim first, falling through to the friend claim ONLY on
            // not_found (any other rec error means the token matched the
            // rec table and failed for a real reason).
            //
            // This fires post-onboarding, so the app is already in (tabs):
            // route DIRECTLY (push / goToProfile) — the claimedRec/
            // claimedFriend param dance on the onboarding invite step
            // exists only to survive the onboarding→tabs replace, which
            // has already happened here.
            if (invite.hint === 'friend') {
                const result = await claimFriendInvite(invite.token);
                if (result.ok) {
                    await clearStash();
                    setPending(null);
                    goToProfile({ userId: result.userId });
                    return;
                }
                // All friend-claim errors are terminal for an auto-claim
                // (not_found / own_rec / unavailable) except generic
                // (network) — keep that stash so the next session retries.
                if (result.error !== 'generic') {
                    await clearStash();
                    setPending(null);
                }
                console.warn('invite auto-claim (friend) failed:', result.error);
                return;
            }

            const recResult = await claimPendingRec(invite.token);
            if (recResult.ok) {
                await clearStash();
                setPending(null);
                router.push(`/rec/${recResult.recId}`);
                return;
            }
            if (invite.hint === 'rec' || recResult.error !== 'not_found') {
                // already_claimed: a silent no-op success for an auto-claim
                // (likely our own earlier claim of the same tapped link) —
                // clear and stay put, never surface the error copy.
                // own_rec / unavailable: terminal, clear. generic: keep the
                // stash for a next-session retry.
                if (recResult.error !== 'generic') {
                    await clearStash();
                    setPending(null);
                }
                console.warn('invite auto-claim (rec) failed:', recResult.error);
                return;
            }
            // Bare token, rec claim said not_found → try the friend family.
            const friendResult = await claimFriendInvite(invite.token);
            if (friendResult.ok) {
                await clearStash();
                setPending(null);
                goToProfile({ userId: friendResult.userId });
                return;
            }
            if (friendResult.error !== 'generic') {
                await clearStash();
                setPending(null);
            }
            console.warn('invite auto-claim (fallback) failed:', friendResult.error);
        })();
    }, [pending, authedOnboarded, launchDone]);
}
