# Seen — Technical Specification

Companion to PRD.md. This document is the source of truth for the data model, security rules, and screen contracts.

## 1. Data model

All tables in the `public` schema. Row Level Security enabled on every table.

### `profiles`
Public user info. One row per auth user, created via trigger on auth signup.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, FK to auth.users.id |
| handle | text | Unique, lowercase, 3-20 chars, [a-z0-9_] |
| display_name | text | Free text, 1-50 chars |
| avatar_url | text | Optional; defaults to generated |
| handle_changed_at | timestamptz | For 30-day cooldown |
| deleted_at | timestamptz | Soft delete; NULL = active |
| created_at | timestamptz | Default now() |

Index: `handle` (unique), `deleted_at`

### `handle_history`
Old handles, quarantined 90 days before reuse.

| Column | Type | Notes |
|---|---|---|
| handle | text | PK, lowercase |
| released_at | timestamptz | When freed |
| available_at | timestamptz | released_at + 90 days |

### `items`
A user's library entry for a title. One row per (user, tmdb_id, media_type).

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK profiles.id, ON DELETE CASCADE |
| tmdb_id | int | TMDB ID |
| media_type | text | 'movie' or 'tv' |
| status | text | 'watchlist' / 'watching' / 'watched' |
| rating | int | NULL or 1-5, only if status='watched' |
| is_private | bool | Default false |
| watched_at | timestamptz | Set when status moves to 'watched' |
| created_at | timestamptz | Default now() |
| updated_at | timestamptz | Trigger-updated |

Unique constraint: (user_id, tmdb_id, media_type)
Indexes: user_id, (user_id, status), (user_id, is_private)

### `friendships`
Mutual accepted friendship between two users. Always stored with user_a_id < user_b_id (lexicographic) to prevent duplicates.

| Column | Type | Notes |
|---|---|---|
| user_a_id | uuid | FK profiles.id, ON DELETE CASCADE |
| user_b_id | uuid | FK profiles.id, ON DELETE CASCADE |
| created_at | timestamptz | Default now() |

PK: (user_a_id, user_b_id)
Index: user_b_id (for reverse lookups)

### `friend_requests`
Pending friend requests. Removed once accepted (becomes a friendship row) or declined.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| from_user_id | uuid | FK profiles.id, ON DELETE CASCADE |
| to_user_id | uuid | FK profiles.id, ON DELETE CASCADE |
| created_at | timestamptz | Default now() |

Unique constraint: (from_user_id, to_user_id)
Index: to_user_id

### `recommendations`
A rec sent from one user to one user. Multi-friend recommend creates N rows.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| from_user_id | uuid | FK profiles.id, ON DELETE SET NULL (for anonymised) |
| to_user_id | uuid | FK profiles.id, ON DELETE CASCADE |
| tmdb_id | int | |
| media_type | text | 'movie' or 'tv' |
| note | text | NULL or up to 500 chars |
| status | text | 'pending' / 'watched' / 'dismissed' / 'saved' |
| dismiss_reason | text | NULL / 'not_for_me' / 'already_watched' / custom text |
| watched_via_rec | bool | If recipient marked watched while rec was open |
| sent_at | timestamptz | Default now() |
| resolved_at | timestamptz | Set when status moves off 'pending' |

Unique constraint: (from_user_id, to_user_id, tmdb_id, media_type) — prevents re-sends
Indexes: (to_user_id, status), (from_user_id, status)

### `invite_links`
Personal invite tokens. One per user, regeneratable.

| Column | Type | Notes |
|---|---|---|
| user_id | uuid | PK, FK profiles.id, ON DELETE CASCADE |
| token | text | Random, URL-safe, unique |
| created_at | timestamptz | |
| revoked_at | timestamptz | NULL = active |

Unique index: token (where revoked_at IS NULL)

### `notifications`
In-app notification feed. Drives push and the bell icon.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK profiles.id, ON DELETE CASCADE |
| kind | text | 'rec_received' / 'rec_watched' / 'friend_request' / 'friend_accepted' |
| payload | jsonb | Kind-specific data (rec_id, friend_id, tmdb_id, etc.) |
| read_at | timestamptz | NULL = unread |
| created_at | timestamptz | Default now() |

Index: (user_id, read_at), (user_id, created_at)

## 2. Row Level Security policies

Principle: by default, deny. Each table gets explicit `auth.uid()`-based policies.

### profiles
- SELECT: anyone authenticated can read any profile (handle, display_name, avatar). Required for search.
- UPDATE: only `id = auth.uid()`.
- INSERT: blocked; created via signup trigger only.
- DELETE: blocked; account deletion via dedicated Edge Function.

### items
- SELECT: own rows always. Friends' rows where `is_private = false`.
- INSERT/UPDATE/DELETE: only `user_id = auth.uid()`.

### friendships
- SELECT: own rows (user is either user_a or user_b).
- INSERT/DELETE: only via Edge Function (`accept_friend_request`, `unfriend`).

### friend_requests
- SELECT: rows where you are sender or recipient.
- INSERT: only `from_user_id = auth.uid()`, only if no existing friendship and no inverse pending request.
- DELETE: only sender or recipient.

### recommendations
- SELECT: rows where you are sender or recipient.
- INSERT: only `from_user_id = auth.uid()`, only to friends, only if no existing (sender, recipient, tmdb_id, media_type) row.
- UPDATE: recipient can update `status`, `dismiss_reason`. Sender cannot edit after send.

### invite_links
- SELECT: own row only.
- UPDATE: own row only (regenerate token).
- INSERT: blocked; created via signup trigger.

### notifications
- SELECT: own rows only.
- UPDATE: own rows only (mark read).
- INSERT: only via server-side triggers/functions.

## 3. Edge Functions / database functions

- `accept_friend_request(request_id)` — moves friend_request → friendships row, deletes request, creates notifications for both users.
- `decline_friend_request(request_id)` — deletes request silently.
- `unfriend(other_user_id)` — deletes friendship row. Recs remain.
- `claim_invite_link(token)` — creates immediate mutual friendship between token owner and auth.uid().
- `delete_account()` — initiates 30-day soft delete. Sets profiles.deleted_at, deletes items, anonymises sent recommendations (sets from_user_id NULL), removes friendships, schedules hard delete via cron.
- `restore_account()` — clears deleted_at if within 30 days.
- `send_recommendation_notifications(rec_id)` — triggered on recommendation INSERT, batches per sender within 5-minute window for push.

## 4. Screens

### Auth / Onboarding
- `(auth)/sign-in` — provider picker
- `(onboarding)/handle` — set display name + handle
- `(onboarding)/last-watched` — quick TMDB add
- `(onboarding)/best-watched` — quick TMDB add
- `(onboarding)/watchlist-three` — add three to watchlist
- `(onboarding)/invite` — invite friends or skip

### Tabs (post-onboarding)
- `(tabs)/index` — Home: incoming recs + friend activity stub + your watchlist preview
- `(tabs)/library` — your library, tabs for watchlist / watching / watched
- `(tabs)/search` — TMDB search
- `(tabs)/friends` — friends list, requests, invite
- `(tabs)/profile` — settings, account, sign out

### Modals / detail
- `title/[mediaType]/[tmdbId]` — title detail; status controls; recommend button
- `recommend/[mediaType]/[tmdbId]` — friend picker with state indicators
- `inbox` — incoming recs (accessible from home)
- `rec/[id]` — single rec detail; dismiss / watched / save actions

## 5. Conventions

- Files: kebab-case for components and screens (`title-detail.tsx`, not `TitleDetail.tsx`).
- Components: PascalCase exports.
- Hooks: `use-*` prefix.
- Server functions: snake_case (matches Postgres).
- TMDB calls: never from components. Always via `src/lib/tmdb.ts`.
- Supabase calls: typed via generated types in `src/lib/database.types.ts`.
- All times: store UTC, display local.

## 6. Type generation

After every schema change, regenerate types:

```bash
npx supabase gen types typescript --project-id [project-ref] > src/lib/database.types.ts
```

This is non-negotiable - TypeScript correctness throughout the app depends on it.