/**
 * Incoming-URL recognisers — the single source of truth for classifying
 * URLs the app is opened with.
 *
 * CONTRACT: every incoming-URL consumer (useInviteLink, the future
 * useAuthLink, +native-intent) acts ONLY on URLs its recogniser matches,
 * and the recognisers must be PAIRWISE DISJOINT — no URL may match two
 * families. Today that disjointness is structural: invite URLs live on
 * the `i`/`r` hosts (scheme) or `/i/`,`/r/` paths (https), auth URLs on
 * the `auth` host. Keep it that way when adding a family, and keep the
 * router steering (+native-intent) importing from HERE so it can never
 * drift from what the handlers recognise.
 */

// ---------------------------------------------------------------------------
// Invite family — seen://i, seen://r, https://seenrecs.com/i/, /r/
// ---------------------------------------------------------------------------

// The scheme shape puts i/r in the HOST position (seen://i?t=…), which
// parseInviteInput's hint regexes — written for the https PATH shape
// (/i/?t=…) — don't match; the token would still parse via the bare-token
// fallback but the hint would be lost. Normalising the scheme URL to the
// path shape (rather than widening the parser) keeps parseInviteInput's
// behaviour byte-identical for its existing paste-flow callers.
// (Moved verbatim from use-invite-link.ts — the query is OPTIONAL here,
// unlike the steering recognisers below, because normalisation happens
// before token parsing, which does its own validation.)
export function normalizeInviteUrl(url: string): string {
    const match = url.match(/^seen:\/\/(i|r)\/?(\?.*)?$/);
    if (match) {
        return `https://seenrecs.com/${match[1]}/${match[2] ?? ''}`;
    }
    return url;
}

// Steering recognisers — deliberately NARROW (the exact invite shapes
// with a query string, not "any URL with a t= param"):
//   scheme  seen://i?t=…    seen://r?t=…    (with or without the slash)
//   https   https://seenrecs.com/i/?t=…     https://seenrecs.com/r/?t=…
// (Moved verbatim from +native-intent.ts.)
const SCHEME_INVITE_RE = /^seen:\/\/(?:i|r)\/?\?/;
const HTTPS_INVITE_RE = /^https:\/\/(?:www\.)?seenrecs\.com\/(?:i|r)\/?\?/;

export function isInviteUrl(url: string): boolean {
    return SCHEME_INVITE_RE.test(url) || HTTPS_INVITE_RE.test(url);
}

// ---------------------------------------------------------------------------
// Auth family — seen://auth/callback (email verification, PKCE ?code=…)
//               seen://auth/reset    (password recovery)
// ---------------------------------------------------------------------------

const AUTH_URL_RE = /^seen:\/\/auth\//;
const AUTH_RESET_RE = /^seen:\/\/auth\/reset(?:[/?#]|$)/;

export function isAuthUrl(url: string): boolean {
    return AUTH_URL_RE.test(url);
}

// Reset links land on the set-new-password screen; every other auth
// callback completes silently and routes onward from the handler.
export function isAuthResetUrl(url: string): boolean {
    return AUTH_RESET_RE.test(url);
}
