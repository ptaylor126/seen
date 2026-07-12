import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import type { SessionState } from '@/hooks/use-session';
import { goToProfile } from '@/lib/profile-nav';

// Resolve a tapped push notification's data payload to a navigation action, or
// null for "no deep route — just foreground". The `data` field mirrors what
// send-push-notification builds: { kind, notification_id, ...notif.payload }.
// Seven rec kinds carry recommendation_id and open that rec's thread; the rest
// map to their own surfaces. A known rec kind missing its id, or an unknown
// kind, falls back to the inbox rather than dropping the tap silently (matching
// the inbox's own buildGeneric fallback). report_filed is a maintainer-only,
// push-only alert with no in-app destination → no-op.
function resolveNavigation(
    data: Record<string, unknown>,
): (() => void) | null {
    const kind = typeof data.kind === 'string' ? data.kind : null;
    const recId =
        typeof data.recommendation_id === 'string'
            ? data.recommendation_id
            : null;
    const chatId = typeof data.chat_id === 'string' ? data.chat_id : null;

    switch (kind) {
        case 'rec_received':
        case 'rec_watched':
        case 'rec_reacted':
        case 'rec_commented':
        case 'comment_reacted':
        case 'rec_declined':
        // rec_claimed: someone joined Seen from the user's rec invite —
        // the claim created a real rec whose id rides in the payload.
        case 'rec_claimed':
            return recId
                ? () => router.push(`/rec/${recId}`)
                : () => router.push('/inbox');
        case 'chat_commented':
        case 'chat_reacted':
        case 'chat_comment_reacted':
            return chatId
                ? () => router.push(`/chat/${chatId}`)
                : () => router.push('/inbox');
        case 'friend_request':
            return () => router.push('/friends/requests');
        case 'friend_accepted': {
            // Payload carries from_user_id but no handle — delegate to
            // goToProfile, which owns the userId → profile-screen convention.
            const userId =
                typeof data.from_user_id === 'string'
                    ? data.from_user_id
                    : null;
            return userId
                ? () => goToProfile({ userId })
                : () => router.push('/inbox');
        }
        case 'rec_requested':
            // No rec thread exists for a request — the inbox is the least
            // surprising landing (not the recommend composer).
            return () => router.push('/inbox');
        case 'watchlist_overlap':
            // Never pushes (informational kind, no buildMessage case) —
            // mapped for completeness like chat_comment_reacted; the inbox
            // row is the real surface.
            return () => router.push('/inbox');
        case 'report_filed':
            return null;
        default:
            return () => router.push('/inbox');
    }
}

// Deep-links a tapped push notification to the relevant screen. Mounted once in
// RootLayoutInner (has session / profile / launchActive in scope). Renders
// nothing.
//
// useLastNotificationResponse covers BOTH cold start (returns the notification
// that launched the app) and warm taps (updates while the app is alive). The
// response is retained across renders until a newer tap supersedes it, so the
// cold-start "pending" route needs no explicit stash: we simply re-check the
// gate each render and fire once it opens.
//
// Gate — navigate only when:
//   - authedOnboarded: signed in AND onboarded. A signed-out / mid-onboarding
//     tap never deep-links (a genuinely new user's intent survives, retained,
//     and fires the moment they finish onboarding — by design).
//   - launchDone (= !launchActive): the launch overlay has dismissed. This is
//     the cold-start gate. Navigating while the overlay is still up pushes
//     /rec/… onto the stack, which flips segments off '(tabs)' and un-satisfies
//     RootLayoutInner's launch-`ready` condition (inTabsGroup && homeReady),
//     wedging the overlay until its safety timeout. Waiting for launchDone lets
//     the launch → home sequence finish first, THEN pushes the deep route onto
//     the settled (tabs) stack. Warm taps: launchActive is already false (it's
//     a one-time overlay), so they fire immediately from wherever the user is.
export function usePushNavigation({
    session,
    profile,
    launchDone,
}: {
    session: SessionState;
    profile: { status: 'loading' | 'ready'; profile: { onboarded: boolean } | null };
    launchDone: boolean;
}): void {
    const response = Notifications.useLastNotificationResponse();
    // De-dupe on the OS notification identifier: the effect re-runs whenever the
    // gate signals change while the same response is still retained — fire once.
    const handledId = useRef<string | null>(null);

    const authedOnboarded =
        session.status === 'ready' &&
        !!session.session &&
        profile.status === 'ready' &&
        !!profile.profile?.onboarded;

    useEffect(() => {
        if (!response) return; // app opened normally, not via a tap
        if (!authedOnboarded || !launchDone) return; // gate closed — wait (implicit stash)

        const id = response.notification.request.identifier;
        if (handledId.current === id) return;
        handledId.current = id;

        const data = (response.notification.request.content.data ?? {}) as Record<
            string,
            unknown
        >;
        const navigate = resolveNavigation(data);
        navigate?.();
    }, [response, authedOnboarded, launchDone]);
}
