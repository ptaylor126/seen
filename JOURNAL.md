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
- Third migration applied: `supabase/migrations/20260518123418_create_items.sql` — creates `public.items` per TECHNICAL §1 with five constraints (media_type/status/rating-range/rating-only-when-watched/unique `(user_id,tmdb_id,media_type)`), three indexes, and a BEFORE UPDATE trigger calling a new generic `public.set_updated_at()` helper. Adds `public.is_friend_of_auth(uuid)` — plpgsql/stable/security-definer with `set search_path = public`. Wrapped in plpgsql specifically so policy creation succeeds before the `friendships` table exists (plpgsql defers name resolution); first call against a non-owner row will raise until the friendships migration lands, which is the expected window. Four policies: SELECT own-or-(non-private friend), INSERT/UPDATE/DELETE own. Auditor PASS, verified all seven items via `supabase db query --linked`. Committed `0a2acdb`.
- Fourth migration applied: `supabase/migrations/20260518124510_create_friendships_and_friend_requests.sql` — creates `public.friendships` (PK `(user_a_id,user_b_id)` + lexicographic CHECK + index on user_b_id) and `public.friend_requests` (PK uuid + unique `(from,to)` + self-CHECK + index on to_user_id), all FKs ON DELETE CASCADE. Adds `public.can_send_friend_request(uuid)` helper (security-definer, stable) used by the friend_requests INSERT policy to enforce the no-existing-friendship + no-reverse-pending-request preconditions. Adds four security-definer RPCs: `accept_friend_request`, `decline_friend_request`, `unfriend` (does NOT touch recommendations per PRD §5), and `claim_invite_link` (idempotent on existing friendship, supersedes either-direction pending request). Policies: friendships SELECT-only (own-side); friend_requests SELECT/INSERT/DELETE for party. Verified after push that `is_friend_of_auth` now executes against the real friendships table (forced a non-null auth.uid via `set_config('request.jwt.claims', …)`). Auditor PASS, committed `4c8796b`.
- Discovered the Supabase MCP server hasn't been exposing tools in-session; used `supabase db query --linked` (Management API) as the verification path instead. Docker isn't running, so `supabase db dump` doesn't work either — same workaround applies.

**Next** (Foundation phase per PRD §9.1)
- Write the remaining migrations for TECHNICAL §1 (`recommendations`, `notifications`, `push_tokens`). For each: enable RLS, write SELECT/INSERT/UPDATE/DELETE policies, then run the `rls-auditor` subagent before applying. After all tables land, revisit the four RPCs' TODOs to insert notifications (kinds `friend_accepted` from accept/claim).
- Build `src/lib/supabase.ts` client and `src/lib/tmdb.ts` (the TMDB wrapper hits the `tmdb-proxy` Edge Function — no direct TMDB calls from the client)
- Create `src/theme/theme.ts` from DESIGN.md tokens; delete `src/constants/theme.ts` and the starter components (app-tabs, collapsible, starter `index.tsx`/`explore.tsx`); replace with minimal placeholders until real auth/onboarding screens land

**Open questions**
- None material before schema work begins.
