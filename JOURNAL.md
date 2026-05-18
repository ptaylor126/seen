# Seen — Session Journal

Running session log. Newest entries at top. Read this first to brief future Claude Code sessions on current state.

---

## 2026-05-18

**Done**
- Wrote PRD.md, TECHNICAL.md (data model + RLS rules + screens), DESIGN.md (tokens, motion, type)
- Downgraded the project from Expo SDK 55 → SDK 54 so it runs in Expo Go on a physical iPhone
- Reverted SDK 55-specific call sites: native-tabs `Icon`/`Label` imports, `SymbolView` `name` props, `useColorScheme` null handling
- Added `@expo-google-fonts/dm-sans` (typography per DESIGN.md)
- Enabled Claude Code plugins: `expo` (SDK skills) and `claude-code-setup` (automation recommender)
- Produced automation recommendations for the Foundation phase: Supabase MCP, context7 MCP, `rls-check` and `new-supabase-migration` skills, `.env` block + tsc-on-edit hooks, `rls-auditor` and `supabase-schema-reviewer` subagents — none implemented yet
- `expo-doctor` 17/17 clean; `tsc --noEmit` clean on `main`

**Next** (Foundation phase per PRD §9.1)
- Create Supabase dev project; capture project-ref; decide where keys live (not in committed `.env.local`)
- Author initial migrations with RLS for: `profiles`, `handle_history`, `items`, `friendships`, `friend_requests`, `recommendations`, `invite_links`, `notifications`
- Add auth-signup trigger that creates a `profiles` row and an `invite_links` row
- Build `src/lib/supabase.ts` client and generate `src/lib/database.types.ts` via `supabase gen types`
- Build `src/lib/tmdb.ts` wrapper for TMDB v4 Read Access Token
- Implement Sign in with Apple (iOS) and Google Sign-In (Android) flows
- TMDB search screen, "add to library", library view (watchlist / watching / watched tabs)
- Create `src/theme/theme.ts` from DESIGN.md tokens (referenced by AGENTS.md but file does not yet exist)
- Delete starter components dependent on `src/constants/theme.ts` (app-tabs, collapsible, starter index/explore screens). Replace with minimal placeholder screens until real auth/onboarding screens land.
- Decide whether to set up the Supabase MCP now (read-only against dev) before writing migrations

**Open questions**
- TMDB token: stored client-side via `EXPO_PUBLIC_*` or proxied through an Edge Function? PRD is silent
- Push notifications: where do device tokens live? No `push_tokens` table in TECHNICAL.md yet
- Account-deletion cron: Supabase `pg_cron` setup and hard-delete job location TBD
- App route structure: `src/app/` currently has `index.tsx` + `explore.tsx` from the starter; needs `(auth)`, `(onboarding)`, `(tabs)` groups per TECHNICAL §4
- DESIGN.md points at `src/theme/theme.ts`; the current code still uses `src/constants/theme.ts` (created by the starter)
- Handle search vs. `profiles` SELECT policy: PRD says mutual-accept gate, TECHNICAL says any authenticated user can read profiles — reconfirm the boundary
