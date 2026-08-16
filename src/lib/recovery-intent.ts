/**
 * Cross-tree signal: a password-reset (recovery) flow is in progress.
 *
 * Set by useAuthLink the moment it recognises an auth-RESET url
 * (isAuthResetUrl) — BEFORE the PKCE code exchange — so the root layout's
 * routing effect never sees a single frame where the recovery session
 * exists without knowing what it is. While set, root routing's ONLY
 * destination for a session-holder is /reset-password; it never routes
 * into a profile-dependent screen.
 *
 * Module state (same tree-independent registry pattern as
 * notification-signal.ts) because the writer (useAuthLink), the reader
 * (root routing effect), and the clearers (the reset screen's complete and
 * abandon paths) live in different parts of the tree. In-memory on
 * purpose: a force-killed app restarts with the flag down and the
 * persisted session restores as a normal session — the accepted
 * force-kill caveat, unchanged.
 *
 * Cleared on EVERY terminal path — password updated, reset abandoned
 * (back-out sign-out), and the exchange failure branches — so a later
 * normal sign-in can never be misrouted by a stale flag.
 */
import { useSyncExternalStore } from 'react';

let recoveryActive = false;
const listeners = new Set<() => void>();

export function setRecoveryIntent(value: boolean): void {
    if (recoveryActive === value) return;
    recoveryActive = value;
    listeners.forEach((cb) => cb());
}

export function getRecoveryIntent(): boolean {
    return recoveryActive;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

// React binding for the root routing effect.
export function useRecoveryIntent(): boolean {
    return useSyncExternalStore(subscribe, getRecoveryIntent);
}
