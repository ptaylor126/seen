// Steers expo-router AWAY from invite URLs. Without this, an incoming
// seen://i?t=… (or, once app links ship, https://seenrecs.com/i/?t=…)
// reaches the router's matcher, which tries to resolve `i` / `r` as a
// screen, fails, and renders the built-in Unmatched Route screen — and on
// a cold start that screen's segments (neither (tabs) nor (auth) nor
// (onboarding)) wedge the launch overlay's `ready` condition until its 8s
// safety timeout.
//
// This ONLY steers the router. The claim pipeline is unaffected by
// design: useInviteLink reads the ORIGINAL url via expo-linking's
// useLinkingURL, whose native module (ExpoLinkingModule.onURLReceived /
// getLinkingURL) is fed directly from the activity lifecycle listener —
// upstream of, and independent from, expo-router's linking layer where
// redirectSystemPath runs. The hook still sees the token; the router just
// lands on home, where the claim then routes.
//
// Contract (expo-router types.d.ts / getLinkingConfig.js): receives the
// full URL as `path` on both cold (`initial: true`) and warm
// (`initial: false`) opens; the return value is what the router matches.
// Anything that isn't an invite URL passes through untouched, so every
// existing deep route (seen://rec/…, push-tap navigation) is unaffected.

// Deliberately NARROW matchers — the exact invite shapes only, not "any
// URL with a t= param":
//   scheme  seen://i?t=…    seen://r?t=…    (with or without the slash)
//   https   https://seenrecs.com/i/?t=…     https://seenrecs.com/r/?t=…
const SCHEME_INVITE_RE = /^seen:\/\/(?:i|r)\/?\?/;
const HTTPS_INVITE_RE = /^https:\/\/(?:www\.)?seenrecs\.com\/(?:i|r)\/?\?/;

export function redirectSystemPath({
    path,
}: {
    path: string;
    initial: boolean;
}): string {
    if (SCHEME_INVITE_RE.test(path) || HTTPS_INVITE_RE.test(path)) {
        // Home. The stashed token claims from there and routes onward.
        return '/';
    }
    return path;
}
