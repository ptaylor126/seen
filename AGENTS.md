# Seen

Read the exact versioned Expo docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code that uses Expo APIs.

## What this is

Seen is a mobile app for tracking films and TV shows and sharing personal recommendations with friends. The differentiator is that recommendations come from people you know and trust, not strangers. It is not a public review platform.

## Reference documents

- `PRD.md` — product requirements, scope, and locked decisions
- `TECHNICAL.md` — data model, RLS rules, screens, conventions
- `DESIGN.md` — visual language and motion principles
- `src/theme/theme.ts` — design tokens (always import from here, never hardcode)

Read these before suggesting changes that touch product scope, data model, or visual design.

## Tech stack

- **App**: React Native via Expo (SDK 54), TypeScript, Expo Router for file-based navigation
- **Backend**: Supabase (Postgres + Auth + Realtime + Edge Functions)
- **Content metadata**: TMDB API v4 (Read Access Token)
- **Auth**: Sign in with Apple (iOS), Google Sign-In (Android)
- **Push**: Expo Notifications via Supabase Edge Functions
- **Platforms**: iOS and Android in parallel from one codebase

## Scope (MVP)

In scope:
- Personal library (watchlist / watching / watched)
- TMDB-backed search for films and TV shows (show-level only, no season/episode tracking)
- 1-to-1 recommendations to friends (with optional note)
- Incoming recommendations inbox (separate from watchlist until accepted)
- Friend system: invite link + handle search
- Push notifications for incoming recs and "your rec was watched"

Out of scope (do not build without explicit request):
- Public profiles or public reviews
- Group/broadcast recommendations
- Star ratings or numeric scores (thumbs up/down on completed recs only)
- Episode-level TV tracking
- Streaming service auto-sync
- Gamification (points, badges, streaks)
- Spoiler-management tools
- Letterboxd CSV import (post-MVP)

## Architecture decisions

- Show-level tracking only. TV shows are tracked as a single item, not by season or episode.
- Recommendations are separate from watchlists. A received rec does not auto-add to the recipient's watchlist; they choose to add or dismiss it.
- Credibility is pair-based and silent. We track thumbs up/down per (sender, recipient) pair but do not display a global credibility score.
- Recommending titles you have not personally watched is allowed.
- All user data is gated by Supabase Row Level Security. Every table starts with RLS enabled.

## Code conventions

- TypeScript strict mode. No `any` types except with an inline `// reason:` comment.
- App code lives in `src/`. Expo Router routes live in `src/app/`.
- Supabase client is initialised once and exported from `src/lib/supabase.ts`.
- TMDB client wrapped in `src/lib/tmdb.ts`, never called directly from components.
- Environment variables prefixed `EXPO_PUBLIC_` only when the value is safe to expose in the client bundle.

## Do not

- Suggest libraries or services we have explicitly chosen against (Trakt API, JustWatch, episode-level tracking libs, Firebase, CloudKit).
- Add gamification mechanics.
- Add features outside MVP scope without flagging it and asking first.
- Use Tailwind, NativeWind, or any utility-class CSS library without discussing first.
- Commit `.env.local` or any file containing keys.

## Commands

```bash
npx expo start            # start dev server
npx expo start --clear    # start with cleared cache
npm run ios               # open iOS Simulator
npm run android           # open Android Emulator
```