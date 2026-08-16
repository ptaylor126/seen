# Seen — chat 13 handoff (2026-08-15/16)

## Release state

- **iOS: 1.0.8 submitted** (version-bump resubmission — Apple rejected the rebuild at 1.0.7 because `autoIncrement` only raises the build number; `expo.version` had to move). In review.
- **Android: submitted** alongside it. The vc7-era icon fix (lavender wordmark adaptive-icon foreground + geometry-matched monochrome) rides this binary.
- **OTA path is closed until the new binaries are live**: the version bump alone moved both runtime fingerprints (`expo.version` is hashed into them). Do not `eas update` against production until 1.0.8/vc8 is installed; `npm run ota:gate` is the check.
- Custom SMTP via **Resend** is live on the Supabase project (sender domain verified; auth email rate limit raised to 3000/h). Email/password auth is shippable.

## What shipped this session

- **Android icon fix** — wordmark adaptive icon + monochrome, in the submitted binary.
- **Onboarding overhaul** — welcome screen rebuilt as the sell screen (two-weight cascading headline "People who know your taste, / showing you what to watch", icon support rows); poster-grid step gained the import aside ("Track films elsewhere? Import from your profile."); invite step simplified to heading-only: **"Invite the friends you share recs with"** + invite/skip buttons, body copy removed.
- **Home empty-state rebuild** — `socialEmpty` / `globalEmpty` split; shared empty block ("No recommendations yet." + "Recommend something" → title-first flow + "Add friends"); "Popular right now" poster strip reusing the search tab's discover data, degrades to nothing.
- **Title-first recommend** — `/library/add?recommendMode=title-first`: pick a title first, then recipients; `dismissOnSend` collapses the stack back to home.
- **Invite deep links, end to end** — `seenrecs.com/i/`+`/r/` (and `seen://i|r`) now open the app and auto-friend: website `.well-known` files live and verified (AASA via Apple's CDN check; assetlinks with the Play app-signing key), `associatedDomains` + `intentFilters` in the binary, `+native-intent` steering + `+not-found` fallback, and the `useInviteLink` handler (AsyncStorage stash so the token survives install → sign-up → onboarding, gate on authed+onboarded+launch, fire-once, claim + route). The `useURL` → `useLinkingURL` fix is what made delivery reliable on device.
- **Email/password auth, complete** — `signUpWithEmail`/`signInWithEmail` with a distinct error taxonomy; "Continue with email" (accent) on the sign-in screen; `(auth)/email` form (sign-in default, show/hide password, inline validation, per-code error captions); check-your-email holding state with resend + honest hedged copy; `useAuthLink` PKCE callback handler (`exchangeCodeForSession` only, never manual token parsing) with expired-link recovery routing back to the form; social-collision guidance without detection (unconditional "Already have an account?" lines — anti-enumeration preserved); **Google Sign-In on iOS** beside Apple (Apple stays first per guideline 4.8; per-provider busy state).
- **Account-deletion security fix** — `delete-account` edge function (uid from the verified JWT only, body never read; storage sweep → transactional RPC → `auth.admin.deleteUser` last) and the **keep-sent-recs migration**: sent recs now survive sender deletion de-identified (FK SET NULL + "Former user" rendering) instead of being hard-deleted; deleted user's own comments/reactions and cross-inbox notification identities still swept. Both verified.
- **Password reset, full flow** — "Forgot password?" on the email form → `resetPasswordForEmail` (seen://auth/reset) → unconditional hedged ack with the same-device caveat (PKCE verifier is device-local) → `/reset-password` screen (`updateUser` under the recovery session). **Deterministic recovery routing**: `useAuthLink` raises a recovery-intent (`lib/recovery-intent.ts`) BEFORE the code exchange and root routing respects it, so the reset screen is never a race winner — this also killed the mid-reset flash. **Back-out signs out** (Cancel and unmount both) and clears the intent, so a recovery link can't become a passwordless login and a later normal sign-in can't be misrouted. Verification routing untouched.
- **Profile-transition flash, fixed at the screen** — the "Profile not available" error rendered on every ready+null frame; it now requires a live session plus a settle grace, so sign-out teardown / post-reset refresh show the loader and only a genuine settled miss shows the error. One fix, all transitions.
- **Button styling fixes** — "Invite friends" (friends/add) to the full pill radius; explicit label centering on the reset-request submit.
- **Notification colour token + BRANDING.md rules** — `notification: '#CFC9EE'` added to the theme; the "has seen this" overlap banner moved off the navy family (surface → surfaceAlt → accent all rejected) to the notification lavender with dark `textInverse` content, 12:1 both against the ground and for its text. BRANDING.md now holds the colour law: accent = actions/wayfinding ONLY; the notification lavender is the one non-action bright colour, licensed because toasts are transient.
- **Profile bio** — nullable `bio text` on profiles (160-char CHECK mirroring the client limit; applied directly in the SQL editor + migration file committed for history; trigger untouched, new users get NULL). Edit field in profile/edit (multiline, live counter, save-on-blur/back, empty saves NULL); displayed on own profile and friend profiles (scroll content on the accepted view — the collapsing header is hard-fixed-height), rendered only when set. Inherits profile RLS unchanged (readable by any signed-in non-blocked user, like display name).

## In flight

- 1.0.8/vc8 store review → once live, re-open the OTA path, re-run `ota:gate`, and ship the accumulated JS (see Board — top release task).
- Remote migration history is untracked past June 16 (`supabase_migrations.schema_migrations` drift) — migrations are applied outside `db push`; don't blind-push.

## Board

**Top release task: OTA the accumulated post-1.0.8 JS (password reset, transition-flash fix, button fixes, notification banner, bio) once iOS AND Android 1.0.8 are approved and LIVE.** Reset only reaches users via this OTA — don't forget it. Gate on `npm run ota:gate` passing both platforms.

Design: **accent-usage audit** — classify every periwinkle use as action / wayfinding / decoration per BRANDING.md, pull back the decoration uses (the accent's signal only works if it's scarce).

Next investigate-first build: **reply-to-message**. Then: reaction menu fix · define the chat-behaviour issue · start public-section planning. (Bio: done this session.)

Deferred security items (from the full audit, none critical): per-user rate limit on tmdb-proxy · CAPTCHA/throttle on waitlist inserts · map raw `err.message` load errors to generic copy · session storage → SecureStore/encrypted MMKV · "no dashboard deletes" as standing ops rule (admin-path deletion bypasses the scrub).

## Decisions worth not relitigating

- **Public section: yes in principle** — but it needs its own scoping session; separation-by-layer; two labelled scores. Don't start building it off a side thread.
- **Deletion is per-table policy, not a wipe**: own data removed; received recs kept and de-identified ("Former user"); sender-authored note survives (received-correspondence model, decided in the migration).
- **Collision UX is guidance-without-detection** — no fetch interceptor, no provider lookup; anti-enumeration wins. The transport-tap version was built, then deliberately removed.
- **Apple stays primary on iOS** (guideline 4.8) with Google below it.
- **PKCE + `seen://` for all email-auth links**; codes exchanged via `exchangeCodeForSession` only; the reset screen gates stage 5.
- **Sent recs survive sender deletion** — reversing the June hard-delete policy; the immutability-trigger carve-out (restored with the season migration) is what lets the SET NULL cascade through.

## Lessons

Full versions in JOURNAL (2026-08-15/16 + 2026-08-16 cont.). Headlines: `useURL` misses Android intents (use `useLinkingURL`) · `+native-intent` rewrites before hooks see the URL (preserve params) · `expo.version` is in the fingerprint · Apple needs a version bump, not a build bump (ITMS-90186/90062) · SMTP sender must match the verified domain exactly (550 → signup 500s) · built-in Supabase email is testing-only and the rate limit caps any provider · Play app-signing page moved; assetlinks wants the app-signing key · GitHub Pages + AASA works via Apple's CDN despite octet-stream; `.nojekyll` required · deletion must remove auth.users, uid from the JWT never the body · deletion is per-table policy · verify CC's "not configured" claims against the file (its diagnostic code can lie) · collisions aren't client-detectable (anti-enumeration) · deferred deep-link tokens live in AsyncStorage, verified by force-kill · PKCE reset can't use the PASSWORD_RECOVERY event (URL-type intent before the exchange instead) · a recovery session must sign out on abandon · the transition flash was one screen, not per-flow · accent = act-here only, toasts get the notification lavender (BRANDING.md) · schema changes under history drift: SQL editor + information_schema verify + repo migration file · variable-height content can't join a fixed-height collapsing header.

## Numbers

- Library distribution: **30 zero / 59 tiny / 31 small / 25 real-library**; ~**7** importers; **9/25** loggers have sent a rec.
- 154 auth users at audit time (2026-08-16), all confirmed, zero orphan profiles.

## Marketing

- Email/password + custom SMTP removes the social-only signup gate; invite links (`seenrecs.com/i/`, `/r/`) are now real, installable, auto-friending links — shareable once 1.0.8 is live.
- Before any signup-driving push: raise the Supabase email rate limit to match expected volume (it caps sends regardless of provider) and land the deferred waitlist throttle.
