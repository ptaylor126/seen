/**
 * Single entry point for "go to this user's profile" navigation.
 *
 * The profile screen (src/app/friends/[handle].tsx) is keyed on handle, but
 * several surfaces (rec thread, reviews) only have a userId in scope. This
 * helper accepts EITHER: it prefers the handle (canonical URL), and falls back
 * to a userId query param that the profile screen resolves by id.
 *
 * Uses the imperative `router` singleton so it's callable from anywhere
 * (incl. <UserLink>) without a hook. All the not-found / not-friends / blocked
 * / deleted / own-profile handling lives in the profile screen — this only
 * routes there.
 */
import { router } from 'expo-router';

export function goToProfile(target: {
    handle?: string | null;
    userId?: string | null;
}): void {
    const handle = target.handle?.trim();
    if (handle) {
        // Canonical path. Handles are [a-z0-9_], so no encoding needed.
        router.push(`/friends/${handle}`);
        return;
    }
    const userId = target.userId?.trim();
    if (userId) {
        // No handle in scope — route to the same profile screen with a userId
        // query param. The `u` path segment is a cosmetic placeholder (not a
        // valid handle: handles are >= 3 chars); the screen resolves by the
        // userId param when present.
        router.push(`/friends/u?userId=${userId}`);
        return;
    }
    // Nothing to navigate to — no-op. Callers should guard, but be safe.
}
