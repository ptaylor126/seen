-- Grant table privileges to the authenticated role.
--
-- Postgres permission system has two layers: GRANTs (what a role can do at
-- all) and RLS (which rows within those grants). Our schema phase set up
-- RLS but never granted table privileges to the `authenticated` role, so
-- every client mutation was hitting `permission denied (42501)` before RLS
-- ever ran. This migration backfills the grants per TECHNICAL §2 and by
-- inspection of which mutations the client actually performs.
--
-- Trigger-managed columns (created_at defaults, updated_at trigger,
-- handle_new_user signup, FK SET NULL cascades, etc.) run as the table
-- owner via the trigger system and do not depend on authenticated-role
-- grants.

-- ============================================================================
-- Schema usage (defaults to granted, but explicit is defensive)
-- ============================================================================

grant usage on schema public to authenticated;

-- ============================================================================
-- Table privileges — matched to TECHNICAL §2 policies and the operations
-- the client actually performs.
-- ============================================================================

-- profiles: handle/avatar search reads need SELECT; user can edit own row.
-- INSERT: signup trigger only. DELETE: future delete_account Edge Function.
grant select, update on table public.profiles to authenticated;

-- handle_history: no client access. service_role bypasses grants + RLS;
-- a future Edge Function writes here on handle change.

-- invite_links: read own token; UPDATE for regeneration. INSERT: signup
-- trigger only. DELETE: cascade from profiles, never client-driven.
grant select, update on table public.invite_links to authenticated;

-- items: full CRUD on own rows; RLS gates everything else.
grant select, insert, update, delete on table public.items to authenticated;

-- friendships: read own. Mutations (accept_friend_request / unfriend /
-- claim_invite_link RPCs) are SECURITY DEFINER and do not need client
-- INSERT/UPDATE/DELETE grants on the table itself.
grant select on table public.friendships to authenticated;

-- friend_requests: read where party, send (INSERT), cancel/decline
-- (DELETE). No UPDATE — accept moves the row to friendships via RPC.
grant select, insert, delete on table public.friend_requests to authenticated;

-- recommendations: read where party, send (INSERT), recipient updates
-- status/dismiss_reason/rating_thumb. No DELETE — recs are not
-- user-deletable per TECHNICAL §2.
grant select, insert, update on table public.recommendations to authenticated;

-- notifications: read own + mark read (UPDATE). INSERT only via triggers
-- and RPCs (security definer). No client DELETE — cleanup is by profiles
-- cascade.
grant select, update on table public.notifications to authenticated;

-- push_tokens: full CRUD on own rows. RLS already locks them to user_id =
-- auth.uid() on every operation.
grant select, insert, update, delete on table public.push_tokens to authenticated;

-- ============================================================================
-- Function execute grants — only the functions clients call directly.
-- Postgres defaults EXECUTE to PUBLIC on new functions, but explicit
-- grants make the API contract clear and survive any future revoke-all.
-- ============================================================================

-- Client RPCs (called via supabase.functions.invoke or supabase.rpc):
grant execute on function public.send_recommendation(uuid, integer, text, text) to authenticated;
grant execute on function public.accept_friend_request(uuid) to authenticated;
grant execute on function public.decline_friend_request(uuid) to authenticated;
grant execute on function public.unfriend(uuid) to authenticated;
grant execute on function public.claim_invite_link(text) to authenticated;
grant execute on function public.generate_invite_token() to authenticated;

-- Policy helpers — called from within RLS policy expressions on items
-- and friend_requests. Policies run in the caller's context, so the
-- caller's role still needs EXECUTE even though both functions are
-- SECURITY DEFINER internally.
grant execute on function public.is_friend_of_auth(uuid) to authenticated;
grant execute on function public.can_send_friend_request(uuid) to authenticated;

-- Trigger functions intentionally NOT granted — invoked by their
-- triggers, never by clients: set_updated_at, set_recommendation_resolved_at,
-- enforce_recommendation_immutability, notify_friend_request_received,
-- notify_recommendation_watched, handle_new_user.

-- ============================================================================
-- Sequences
-- ============================================================================

-- No sequence grants needed. Every primary key in the schema is uuid with
-- a `gen_random_uuid()` default, so no serial/identity sequences exist.
