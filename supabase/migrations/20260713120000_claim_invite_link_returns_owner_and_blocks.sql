-- claim_invite_link — bring the May-era friend-invite claim up to the
-- rec-claim RPC's standards (20260712120000), for the seenrecs.com/i/
-- friend-invite loop.
--
-- RECORD-ONLY: applied by hand in the Supabase SQL editor; this file is the
-- record. Do NOT re-apply.
--
-- Three changes, no semantic redesign:
--   1. RETURN the link owner's user id (was void) in EVERY success path —
--      the client claim field routes to the new friend's profile with it.
--      A return-type change can't ride CREATE OR REPLACE, hence the DROP
--      (grants die with the function; re-granted below).
--   2. BLOCK CHECK — the function predates public.blocks (20260625120000);
--      without this a blocked pair can re-friend through a permanent
--      invite link. Same neutral single message as the rec claim so the
--      claimer learns nothing about who blocked whom.
--   3. No other behaviour changes: the token stays PERMANENT + MULTI-CLAIM
--      (never consumed; each distinct claimer gets their own friendship);
--      already-friends stays a silent idempotent success (now returning
--      the owner id instead of nothing, still no duplicate notification);
--      self-claim and not-found/revoked keep their existing stable
--      messages; the owner notification stays kind='friend_accepted' with
--      the invite_link:true payload marker (payload.from_user_id is the
--      claimer — already the key the delete_account_data sweep matches).
--
-- Also here: a narrow service_role SELECT grant on invite_links for the
-- get-invite edge function (the seenrecs.com/i/ landing page's read path).
-- This project deliberately gives service_role no default DML — every
-- table opens the minimum surface explicitly (see 20260609120000).

-- ============================================================================
-- (1) LIVE OBJECT — verify before running. Fetch the CURRENT definition:
--
--     select pg_get_functiondef('public.claim_invite_link(text)'::regprocedure);
--
-- Expected: the 20260518150956 body verbatim (returns void; owner lookup
-- with revoked_at is null; self-claim guard; silent already-friends return;
-- friend_requests cleanup; friendships insert; friend_accepted notification
-- with invite_link:true). If it differs, STOP and reconcile.
-- ============================================================================

drop function public.claim_invite_link(text);

create function public.claim_invite_link(token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    owner_id uuid;
    a uuid;
    b uuid;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;

    if token is null or token = '' then
        raise exception 'invalid token';
    end if;

    select user_id into owner_id
    from public.invite_links
    where invite_links.token = claim_invite_link.token
      and revoked_at is null;

    if not found then
        raise exception 'invite link not found or revoked';
    end if;

    if owner_id = me then
        raise exception 'cannot claim your own invite link';
    end if;

    -- Block check, both directions (is_blocked_pair is the internal 2-arg
    -- helper — callable here as definer). Neutral message either way, same
    -- as claim_pending_recommendation.
    if public.is_blocked_pair(me, owner_id) then
        raise exception 'invite not available';
    end if;

    a := least(me, owner_id);
    b := greatest(me, owner_id);

    if exists (
        select 1 from public.friendships
        where user_a_id = a and user_b_id = b
    ) then
        -- Idempotent: already friends — succeed with the owner id (the
        -- client still routes to the profile), no duplicate notification.
        return owner_id;
    end if;

    delete from public.friend_requests
    where (from_user_id = me and to_user_id = owner_id)
       or (from_user_id = owner_id and to_user_id = me);

    insert into public.friendships (user_a_id, user_b_id)
    values (a, b)
    on conflict (user_a_id, user_b_id) do nothing;

    -- Notify the link owner that their invite turned into a friend. The
    -- claimer (me) doesn't need a self-notification.
    insert into public.notifications (user_id, kind, payload)
    values (
        owner_id,
        'friend_accepted',
        jsonb_build_object(
            'from_user_id', me,
            'invite_link', true
        )
    );

    return owner_id;
end;
$$;

-- The DROP above removed the old grant — re-establish it.
grant execute on function public.claim_invite_link(text) to authenticated;

-- ============================================================================
-- (2) invite_links — service_role SELECT for the get-invite edge function.
-- SELECT only; the function never writes.
-- ============================================================================

grant select on public.invite_links to service_role;

-- The landing page also shows the sender's name + avatar; profiles already
-- carries a service_role SELECT (20260610100000, for the push function's
-- display-name reads) — verified below, no new grant needed.

-- ============================================================================
-- (3) POST-APPLY VERIFICATION — run each, compare to the expectation.
-- ============================================================================

-- Return type changed:
--     select pg_get_function_result('public.claim_invite_link(text)'::regprocedure);
-- Expect: uuid

-- Grant re-established after the drop:
--     select has_function_privilege(
--         'authenticated',
--         'public.claim_invite_link(text)',
--         'execute');
-- Expect: true

-- Block check present in the live body:
--     select pg_get_functiondef('public.claim_invite_link(text)'::regprocedure);
-- Expect: contains is_blocked_pair and 'invite not available'.

-- service_role reads for the edge function:
--     select grantee, privilege_type
--     from information_schema.role_table_grants
--     where table_schema = 'public'
--       and table_name in ('invite_links', 'profiles')
--       and grantee = 'service_role'
--     order by table_name, privilege_type;
-- Expect: invite_links SELECT; profiles SELECT (pre-existing).
