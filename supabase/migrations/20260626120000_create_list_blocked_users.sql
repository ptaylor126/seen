-- list_blocked_users() — powers the in-app "Blocked users" / unblock list
-- (Account → Blocked users). Reviewed by rls-auditor (PASS) before applying.
--
-- Why a SECURITY DEFINER RPC: the profiles SELECT policy hides a blocked user
-- from the blocker too (is_blocked_with_auth is symmetric — see
-- 20260625120000_create_blocks_and_block_user.sql), so a normal client
-- blocks→profiles join returns the block rows but NULL profiles. This function
-- bypasses the profiles RLS ONLY to surface the caller's OWN blocked users'
-- display fields for the unblock screen.
--
-- Safety (audited):
--   * No arguments — the result is hard-scoped to blocker_id = auth.uid();
--     there is no way to coerce it into returning another user's block list or
--     an arbitrary profile. Unauthenticated (auth.uid() NULL) returns zero rows.
--   * Identity from auth.uid() in the body, never a client arg. STABLE,
--     search_path pinned to public.
--   * Returns ONLY the display fields the list needs (id, handle, display_name,
--     avatar_url) plus the block timestamp — explicit projection, never
--     select *, so a future profiles column can't silently widen it.
--   * Does NOT filter deleted_at on purpose: Seen soft-deletes profiles, so a
--     blocked user who later deletes their account stays in the list with their
--     last-known display fields — "a block you can't see is a block you can't
--     clear." The block row persists (soft delete keeps the profile row); the
--     unblock RPC works regardless.
--   * No revoke-from-public: matches the codebase convention for definer
--     functions (grant to authenticated; the body fails closed for anon).

create or replace function public.list_blocked_users()
returns table (
    user_id uuid,
    handle text,
    display_name text,
    avatar_url text,
    blocked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select p.id, p.handle, p.display_name, p.avatar_url, b.created_at
    from public.blocks b
    join public.profiles p on p.id = b.blocked_id
    where b.blocker_id = (select auth.uid())
    order by b.created_at desc;
$$;

grant execute on function public.list_blocked_users() to authenticated;
