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
- Installed Supabase MCP (read-only) against the dev project
- Created `rls-auditor` subagent (`.claude/agents/rls-auditor.md`) — reviews Supabase migrations for RLS correctness against TECHNICAL §2 / PRD §5
- Created PreToolUse `block-secrets` hook (`.claude/hooks/block-secrets.sh`) — blocks Read/Edit/Write on `.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`/`.pypirc`/`.netrc`, and any path containing `credentials`/`secrets` (case-insensitive)
- Resolved 5 open questions in PRD/TECHNICAL/DESIGN: TMDB hybrid proxy via `tmdb-proxy` Edge Function, `push_tokens` table, `pg_cron` daily deletion job, canonical theme path (`src/theme/theme.ts`), profile-visibility clarification

**Next** (Foundation phase per PRD §9.1)
- Write Supabase migrations for the 9 tables in TECHNICAL §1 (`profiles`, `handle_history`, `items`, `friendships`, `friend_requests`, `recommendations`, `invite_links`, `notifications`, `push_tokens`). For each: enable RLS, write SELECT/INSERT/UPDATE/DELETE policies, then run the `rls-auditor` subagent before applying
- Auth-signup trigger that creates a `profiles` row and an `invite_links` row
- Build `src/lib/supabase.ts` client and `src/lib/tmdb.ts` (the TMDB wrapper hits the `tmdb-proxy` Edge Function — no direct TMDB calls from the client)
- Create `src/theme/theme.ts` from DESIGN.md tokens; delete `src/constants/theme.ts` and the starter components (app-tabs, collapsible, starter `index.tsx`/`explore.tsx`); replace with minimal placeholders until real auth/onboarding screens land

**Open questions**
- None material before schema work begins.
