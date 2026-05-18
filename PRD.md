# Seen — Product Requirements Document

Version: 1.0 (MVP)
Status: Approved for build

## 1. Purpose

Seen is a mobile app for tracking films and TV shows and exchanging recommendations between trusted friends. The unit of value is "a specific friend recommended a specific title to me," not "what the crowd thinks." It is explicitly not a public review platform.

## 2. Target user

Adults who consume film and TV regularly and discover new content primarily through friend recommendations. Validated via 41-response survey and 8 interviews (Feb 2025). Key findings:

- 80.5% discover via friend recs
- 77.9% have no tracking system (mental notes or nothing)
- 63.4% would join if invited by a friend
- Universal pain points: chronic scrolling, forgetting what's been watched, recommendations getting lost in WhatsApp, delayed responses from friends

## 3. Differentiation

- Recommendations are 1-to-1 and private. No broadcast, no public reviews.
- Watchlist and recommendations are separate streams. A received rec is an invitation, not an auto-add.
- Credibility between friends is tracked silently per-pair, not displayed as a global score.
- Show-level TV tracking only (no season/episode complexity).

## 4. Platforms and stack

- iOS and Android in parallel from one codebase
- React Native via Expo (SDK 54), TypeScript, Expo Router
- Supabase (Postgres, Auth, Realtime, Edge Functions, Push)
- TMDB API v4 for content metadata. The Read Access Token is stored as a Supabase secret and proxied through a `tmdb-proxy` Edge Function — never bundled into the client. Image URLs are served direct from the TMDB CDN (no proxy for images).
- Sign in with Apple (iOS), Google Sign-In (Android)

## 5. In scope (MVP)

### Core loop
- TMDB-backed search for films and TV shows
- Personal library: watchlist / watching / watched
- Per-item rating: optional 5-star, post-watch
- Per-item private toggle (hide from friends)
- 1-to-1 recommendations to one or more friends (creates N separate records)
- Recommendation note: optional, 500-character limit
- Incoming recommendations inbox, separate from watchlist
- Dismiss rec with optional quick-reply: "Not for me" / "Already watched" / custom / silent. "Save for later" is intentionally NOT a dismiss option — that flow is the separate `accepted` state (adds the title to the watchlist with attribution; rec stays open).
- Mark received rec as watched → sender is notified

#### Recommendation lifecycle

- **pending** — in the recipient's active inbox; not yet acted on.
- **accepted** — recipient added the title to their watchlist with attribution. The rec stays open. Sender is NOT notified at this step; they only get the `rec_watched` push when the title actually gets watched.
- **watched** — terminal. Sender is notified. Trigger fires on transitions from either `pending` or `accepted` into `watched`.
- **dismissed** — terminal. Sender sees the dismiss reason (enum or free text, NULL allowed for silent dismiss).

### Friend system
- Profile info (handle, display name, avatar) is visible to any signed-in user. This enables handle search and friend request discovery. All library activity, recommendations, and notes are gated by friendship.
- Mutual accept required to become friends via handle search (sending a request → recipient accepts)
- Auto-accept via personal invite link
- Unfriend: severs silently, past recs remain visible to both parties
- Friends see each other's library by default; per-item private toggle for exceptions

### Onboarding
1. Splash: "See what your friends are actually watching"
2. Sign in with Apple / Google
3. Set display name + unique handle
4. "What did you watch last night?" → adds one title to watched
5. "What's the best thing you've watched? First thing that comes to mind" → adds one title to watched
6. "Add three things you want to watch next" → three titles to watchlist
7. "Invite three friends — the app gets good when they're on it" → share link, contacts, or skip
8. Land on home

Permissions (push, contacts) requested in context, never upfront.

### Notifications (push)
Always on:
- Incoming recommendation
- Your rec was watched by recipient
- Friend request received / accepted

Default off:
- Friend added something to their watchlist that you also have in yours
- Weekly digest

Never:
- Thumbs/ratings on your rec (too low-value)

Batching: per-sender, 5-minute window. "Sarah recommended 4 things to you" deep-links to inbox.

System DND respected; no in-app quiet hours in MVP.

### Account lifecycle
- Sign in via Sign in with Apple (iOS) / Google (Android)
- Handle changeable once per 30 days; old handle quarantined 90 days before reuse
- Account deletion: hybrid model
  - Personal data (library, ratings, dismissed recs) hard-deleted
  - Outbound recs anonymised in recipients' inboxes (shown as "former user")
  - Friendships removed
  - 30-day soft-delete grace period; login within window restores
- Data export: deferred to post-MVP
- Email: transactional only (welcome, account events). No marketing.

## 6. Out of scope (MVP)

- Public profiles or public reviews
- Followers (asymmetric relationships)
- Group / broadcast recommendations
- Episode-level TV tracking
- Streaming service auto-sync
- Streaming availability data (JustWatch / Watchmode integration)
- Gamification (points, badges, streaks)
- Spoiler-management tools
- Letterboxd CSV import
- Share-sheet extension (post-MVP; planned for v1.1)
- In-app messaging
- Rating philosophy / public profile sections
- Offline writes (read-only offline supported)
- Data export
- In-app quiet hours

## 7. UX rules

- Empty states are meaningful, not blank. Home with no friends shows watchlist + clear "invite friends" nudge.
- Optimistic UI updates: all state changes apply instantly, rollback on server failure with toast.
- Read-only offline: library, inbox, friends viewable offline; search and writes require connection. Clear offline indicator.
- Pagination: 50 items per page in library/inbox, load on scroll. TMDB search loads 20 per page.
- Timestamps: UTC in DB, local timezone in UI. Relative time under 7 days, absolute date after.
- TMDB images via `expo-image` for disk caching.
- Search "no results" offers "request a title" option (mailto for MVP).

## 8. Architecture decisions (locked)

- Show-level tracking. TV stored as a single item, not by season/episode.
- Recommendations table is separate from items table. Recs do not auto-add to recipient's watchlist.
- Recommending titles you haven't watched is allowed.
- Credibility is per-(sender, recipient) pair, derived from existing data. No stored "credibility score" column.
- Row Level Security on every Supabase table.
- One Expo codebase for both platforms.
- All TMDB-sourced metadata fetched on-demand, not mirrored. Store only the TMDB ID and media_type locally.

## 9. Build order

Each step shippable to TestFlight/internal Android before the next:

1. **Foundation**: Supabase schema with RLS, auth (Sign in with Apple/Google), TMDB search, add to library, library view. App is solo-usable.
2. **Social**: Friends system (invite link + handle search), recommend-to-friend flow, incoming recs inbox.
3. **Notifications**: Push for incoming recs, rec-watched, friend requests. Batching.
4. **Polish**: Onboarding flow, empty states, optimistic updates, pagination, offline cache.
5. **Share extension**: iOS Share Extension and Android Share Intent (post-MVP).

Each step is tested with real friends before moving to the next.