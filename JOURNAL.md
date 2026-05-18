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
- First migration applied: `supabase/migrations/20260518114602_create_profiles_and_handle_history.sql` — creates `public.profiles` and `public.handle_history` with check constraints, indexes, RLS, and the `handle_new_user()` signup trigger (security definer, placeholder handle `user_` + 12 hex chars). Auditor PASS, pushed to remote (`xhzrsdgrgimlrdnyzidr`), verified via `supabase inspect db table-stats --linked`. Committed `3ed64d1`.
- Second migration applied: `supabase/migrations/20260518121215_create_invite_links.sql` — creates `public.invite_links` (PK user_id → profiles, partial unique index on token where revoked_at is null) with own-row SELECT/UPDATE RLS, no INSERT/DELETE policies. Adds `public.generate_invite_token()` (plain SQL, ~96-bit base64url, 16 chars via `extensions.gen_random_bytes(12)`). Extends `handle_new_user()` to also insert an `invite_links` row at signup. Auditor PASS, pushed to remote, verified all six items via `supabase db query --linked` (columns, RLS, policies, functions, trigger body, indexes). Committed `5909f3a`.
- Discovered the Supabase MCP server hasn't been exposing tools in-session; used `supabase db query --linked` (Management API) as the verification path instead. Docker isn't running, so `supabase db dump` doesn't work either — same workaround applies.

**Next** (Foundation phase per PRD §9.1)
- Write the remaining migrations for TECHNICAL §1 (`items`, `friendships`, `friend_requests`, `recommendations`, `notifications`, `push_tokens`). For each: enable RLS, write SELECT/INSERT/UPDATE/DELETE policies, then run the `rls-auditor` subagent before applying
- Build `src/lib/supabase.ts` client and `src/lib/tmdb.ts` (the TMDB wrapper hits the `tmdb-proxy` Edge Function — no direct TMDB calls from the client)
- Create `src/theme/theme.ts` from DESIGN.md tokens; delete `src/constants/theme.ts` and the starter components (app-tabs, collapsible, starter `index.tsx`/`explore.tsx`); replace with minimal placeholders until real auth/onboarding screens land

**Open questions**
- None material before schema work begins.
