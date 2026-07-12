-- pending_recommendations + claim_pending_recommendation RPC — the DB side
-- of the invite loop (recommend to someone not on Seen yet).
--
-- RECORD-ONLY: applied by hand in the Supabase SQL editor; this file is the
-- record. Do NOT re-apply.
--
-- Shape (decided in the invite-loop investigation):
--   * SEPARATE table — recommendations.to_user_id stays NOT NULL; no ripple
--     through its policies/triggers/realtime.
--   * Per-rec single-use token via the existing generate_invite_token()
--     (16 base64url chars, ~96 bits — collision odds negligible; the unique
--     index makes a collision a failed insert, not a corrupt row).
--   * Claim = real recommendations row + INSTANT friendship (both sides
--     expressed intent: sender invited, recipient claimed) — modeled on
--     claim_invite_link (20260518124510 / 20260518150956).
--   * The landing page reads via an Edge Function with service_role — the
--     table has NO public/anon read surface. This project grants
--     service_role no DML by default (see 20260609120000's audit note), so
--     a narrow SELECT grant is included here.
--
-- DECISIONS MADE EXPLICIT (flag before applying if any feel wrong):
--   * EXPIRY: none for v1. A link in a text thread should keep working
--     months later; the sender can revoke by deleting the row (DELETE
--     policy below), and a TTL sweep can be added later without schema
--     change (created_at is there to key it).
--   * ALREADY-CLAIMED re-claim: distinct, stable error message
--     ('recommendation already claimed') the client can map to friendly
--     copy — same pattern as the friend-request send errors.
--   * SENDER DELETED FIRST: the row is gone → the RPC raises
--     'recommendation not found' (and the edge function 404s). Clean.
--   * NOTIFICATION: a DISTINCT kind 'rec_claimed' to the SENDER (payload
--     below), NOT a reused rec_received. Tradeoff: rec_received would be
--     zero plumbing but semantically wrong (it's the recipient-side kind;
--     here the SENDER is being told "they joined Seen from your rec", which
--     the inbox can't say without the new kind). Cost: the inbox + push
--     edge function must learn 'rec_claimed' before it renders — that
--     client work ships in the same feature (no claim can occur before the
--     client claim UI exists, so no orphan notifications in practice).
--     NOTE: unread_count counts every kind not in its exclusion list, so a
--     rec_claimed row WILL move the sender's bell even before the inbox
--     renders it — acceptable only because of the same-feature ordering.
--   * THE CLAIMER GETS NO NOTIFICATION ROW: they performed the claim and
--     are routed straight to the rec (the RPC returns its id). The new
--     pending rec still moves their bell naturally via unread_count's
--     recommendations leg (status='pending', not in items) — genuinely new
--     content, no extra row needed.
--   * PAIR-UNIQUE COLLISION: recommendations has unique
--     (from_user_id, to_user_id, tmdb_id, media_type). If the sender
--     already sent this exact title to the claimer through the normal flow
--     (possible when they became friends by another path between send and
--     claim), the claim does NOT fail: it returns the EXISTING rec's id,
--     still marks the pending row claimed, and still ensures the
--     friendship. The sender is not re-notified in that case (the rec
--     already produced its rec_received; a 'rec_claimed' for a rec the
--     recipient already had would be noise) — flag if you'd rather notify
--     anyway.
--   * TITLE STAMPING: like send_recommendation, this RPC does NOT stamp
--     public.titles. The CLIENT calls ensureTitle when CREATING the
--     pending rec (same division of labour as recommend.tsx — see its
--     comment at line ~118), so by claim time the title row exists.

-- ============================================================================
-- (1) pending_recommendations
-- ============================================================================

create table public.pending_recommendations (
    id uuid primary key default gen_random_uuid(),
    token text not null default public.generate_invite_token(),
    from_user_id uuid not null references public.profiles(id) on delete cascade,
    tmdb_id integer not null,
    media_type text not null,
    note text,
    created_at timestamptz not null default now(),
    -- Kept (not deleted) on claim, for attribution: claimed_by is the join
    -- credit. on delete set null so deleting the claimer's account keeps
    -- the sender's attribution row harmless rather than resurrecting an
    -- "unclaimed" token (claimed_at stays set, so the token stays dead).
    claimed_by uuid references public.profiles(id) on delete set null,
    claimed_at timestamptz,
    constraint pending_recommendations_media_type_check
        check (media_type in ('movie', 'tv')),
    constraint pending_recommendations_note_length_check
        check (note is null or char_length(note) <= 500),
    -- claimed_by/claimed_at move together — except the account-deletion
    -- SET NULL above, so: a claimed_by implies claimed_at, but claimed_at
    -- may outlive claimed_by.
    constraint pending_recommendations_claim_consistency_check
        check (claimed_by is null or claimed_at is not null),
    constraint pending_recommendations_no_self_claim_check
        check (claimed_by is null or claimed_by != from_user_id)
);

-- Token lookup path for the edge function + claim RPC. Unique = single-use
-- capability; no partial index needed (rows persist after claim, and a
-- claimed token must still resolve — to the 'already claimed' error — not
-- become reusable).
create unique index pending_recommendations_token_key
    on public.pending_recommendations (token);

-- Sender's own list ("your pending invites").
create index pending_recommendations_from_user_id_idx
    on public.pending_recommendations (from_user_id);

alter table public.pending_recommendations enable row level security;

-- SELECT: sender only. The landing page NEVER reads this table directly —
-- the edge function does, with service_role. The claimer never needs to
-- read the row either; the claim RPC (security definer) does the lookup.
create policy "pending_recommendations_select_own"
    on public.pending_recommendations
    for select
    to authenticated
    using (from_user_id = (select auth.uid()));

-- INSERT: only as yourself, and NEVER with the claim fields pre-set —
-- without the null checks a sender could fabricate "user X joined via my
-- rec" attribution rows (claimed_by/claimed_at pass the table CHECKs for
-- any other profile). Claim fields are written only by the RPC. Content
-- validity (media_type, note length) is enforced by the table CHECKs; the
-- token and id come from column defaults (see the column-level INSERT
-- grant below, which keeps the client from supplying its own token).
create policy "pending_recommendations_insert_self"
    on public.pending_recommendations
    for insert
    to authenticated
    with check (
        from_user_id = (select auth.uid())
        and claimed_by is null
        and claimed_at is null
    );

-- DELETE: sender revokes their own pending rec (before OR after claim —
-- deleting a claimed row only forfeits the sender's own attribution record;
-- the real recommendation and friendship are already independent rows).
create policy "pending_recommendations_delete_own"
    on public.pending_recommendations
    for delete
    to authenticated
    using (from_user_id = (select auth.uid()));

-- No UPDATE policy: the only mutation is the claim, which goes through the
-- security-definer RPC below.

-- Table privileges. authenticated: SELECT/DELETE table-wide (RLS-gated),
-- INSERT restricted to the four client-supplied columns — id/token/
-- created_at/claimed_* are unreachable at insert (defaults + RPC only), so
-- the client cannot mint its own token value. service_role: SELECT only —
-- the narrowest surface the landing-page edge function needs (this project
-- deliberately does NOT give service_role blanket DML; see the audit note
-- in 20260609120000).
grant select, delete on public.pending_recommendations to authenticated;
grant insert (from_user_id, tmdb_id, media_type, note)
    on public.pending_recommendations to authenticated;
grant select on public.pending_recommendations to service_role;

-- ============================================================================
-- (2) notifications kind CHECK — widen to include 'rec_claimed'.
--
-- LIVE OBJECT — verify before running. Fetch the CURRENT live definition:
--
--     select pg_get_constraintdef(oid)
--     from pg_constraint
--     where conname = 'notifications_kind_check'
--       and conrelid = 'public.notifications'::regclass;
--
-- Expected (from 20260710180000): rec_received, rec_watched,
-- friend_request, friend_accepted, rec_reacted, rec_commented,
-- comment_reacted, rec_declined, rec_requested, report_filed,
-- chat_commented, chat_reacted, chat_comment_reacted, watchlist_overlap.
-- If the live list differs, STOP and reconcile — the list below is that
-- list plus 'rec_claimed'.
--
-- unread_count is deliberately NOT touched: its exclusion list
-- ('rec_received', 'watchlist_overlap') is an exclusion list, so the new
-- kind counts toward the sender's bell — desired.
-- ============================================================================

alter table public.notifications
    drop constraint notifications_kind_check;

alter table public.notifications
    add constraint notifications_kind_check
    check (kind in (
        'rec_received',
        'rec_watched',
        'friend_request',
        'friend_accepted',
        'rec_reacted',
        'rec_commented',
        'comment_reacted',
        'rec_declined',
        'rec_requested',
        'report_filed',
        'chat_commented',
        'chat_reacted',
        'chat_comment_reacted',
        'watchlist_overlap',
        'rec_claimed'
    ));

-- ============================================================================
-- (3) claim_pending_recommendation
--
-- NEW function (nothing replaced — no live-fetch ritual needed here).
-- Modeled on claim_invite_link: security definer, friendship idempotent,
-- friend_requests superseded. Additions over that model: block check,
-- single-use enforcement under a row lock, the real rec insert, and the
-- sender notification.
-- ============================================================================

create or replace function public.claim_pending_recommendation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    pending record;
    a uuid;
    b uuid;
    rec_id uuid;
    rec_existed boolean := false;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;

    if p_token is null or p_token = '' then
        raise exception 'invalid token';
    end if;

    -- Row lock serialises concurrent claims of the same token: the second
    -- transaction blocks here, then sees claimed_at set and gets the
    -- 'already claimed' error rather than a double insert.
    select * into pending
    from public.pending_recommendations
    where token = p_token
    for update;

    if not found then
        -- Also the "sender revoked before claim" case (row deleted).
        raise exception 'recommendation not found';
    end if;

    if pending.claimed_at is not null then
        raise exception 'recommendation already claimed';
    end if;

    if pending.from_user_id = me then
        raise exception 'cannot claim your own recommendation';
    end if;

    -- Block check, both directions. is_blocked_pair is the internal 2-arg
    -- helper (not granted to authenticated) — callable here because this
    -- function runs as the definer. Deliberately the same neutral message
    -- either way; the claimer learns nothing about who blocked whom.
    if public.is_blocked_pair(me, pending.from_user_id) then
        raise exception 'recommendation not available';
    end if;

    -- Friendship — instant and idempotent (claim_invite_link pattern):
    -- both sides expressed intent. Any pending friend_request in either
    -- direction is superseded. ON CONFLICT guards the race with a
    -- concurrent accept_friend_request creating the same pair.
    a := least(me, pending.from_user_id);
    b := greatest(me, pending.from_user_id);

    delete from public.friend_requests
    where (from_user_id = me and to_user_id = pending.from_user_id)
       or (from_user_id = pending.from_user_id and to_user_id = me);

    insert into public.friendships (user_a_id, user_b_id)
    values (a, b)
    on conflict (user_a_id, user_b_id) do nothing;

    -- The real recommendation, sender → claimer. If the identical rec
    -- already exists (recommendations_pair_unique — sender re-recommended
    -- through the normal flow between send and claim), reuse it: the claim
    -- still succeeds, still returns a routable id, and skips the sender
    -- notification (their rec already notified once).
    insert into public.recommendations
        (from_user_id, to_user_id, tmdb_id, media_type, note)
    values
        (pending.from_user_id, me, pending.tmdb_id, pending.media_type,
         pending.note)
    on conflict (from_user_id, to_user_id, tmdb_id, media_type) do nothing
    returning id into rec_id;

    if rec_id is null then
        rec_existed := true;
        select id into rec_id
        from public.recommendations
        where from_user_id = pending.from_user_id
          and to_user_id = me
          and tmdb_id = pending.tmdb_id
          and media_type = pending.media_type;
        -- Guard the narrow race: the pre-existing rec deleted between the
        -- ON CONFLICT and this select. Abort (rolling back the friendship/
        -- request writes too) rather than mark the token claimed while
        -- returning nothing routable.
        if rec_id is null then
            raise exception 'recommendation not available';
        end if;
    end if;

    update public.pending_recommendations
    set claimed_by = me,
        claimed_at = now()
    where id = pending.id;

    -- Tell the sender their rec brought someone onto Seen. from_user_id is
    -- the ACTOR key (the claimer): delete_account_data (20260622120000)
    -- sweeps other users' inboxes on payload->>'from_user_id', so without
    -- it a deleted claimer's uuid would linger here (PRD §5). claimed_by
    -- duplicates it under the semantically-named key for the client.
    if not rec_existed then
        insert into public.notifications (user_id, kind, payload)
        values (
            pending.from_user_id,
            'rec_claimed',
            jsonb_build_object(
                'from_user_id', me,
                'claimed_by', me,
                'recommendation_id', rec_id,
                'pending_recommendation_id', pending.id,
                'tmdb_id', pending.tmdb_id,
                'media_type', pending.media_type
            )
        );
    end if;

    return rec_id;
end;
$$;

grant execute on function public.claim_pending_recommendation(text) to authenticated;

-- ============================================================================
-- (4) POST-APPLY VERIFICATION — run each, compare to the expectation.
-- ============================================================================

-- Table exists with the expected columns:
--     select column_name, data_type, is_nullable
--     from information_schema.columns
--     where table_schema = 'public'
--       and table_name = 'pending_recommendations'
--     order by ordinal_position;
-- Expect 9 rows: id, token, from_user_id, tmdb_id, media_type, note,
-- created_at, claimed_by, claimed_at (note/claimed_by/claimed_at nullable).

-- RPC exists:
--     select to_regprocedure('public.claim_pending_recommendation(text)');
-- Expect: claim_pending_recommendation(text)  (not null).

-- RLS enabled + exactly three policies:
--     select relrowsecurity
--     from pg_class where oid = 'public.pending_recommendations'::regclass;
-- Expect: true.
--     select policyname, cmd
--     from pg_policies
--     where schemaname = 'public'
--       and tablename = 'pending_recommendations'
--     order by policyname;
-- Expect: pending_recommendations_delete_own (DELETE),
--         pending_recommendations_insert_self (INSERT),
--         pending_recommendations_select_own (SELECT). No UPDATE policy.

-- INSERT policy carries the anti-fabrication guards:
--     select with_check
--     from pg_policies
--     where schemaname = 'public'
--       and tablename = 'pending_recommendations'
--       and policyname = 'pending_recommendations_insert_self';
-- Expect the expression to include: from_user_id = auth.uid(),
-- claimed_by IS NULL, claimed_at IS NULL.

-- Table-level grants (authenticated: select/delete; service_role: select
-- ONLY — INSERT is deliberately absent here because it's column-level):
--     select grantee, privilege_type
--     from information_schema.role_table_grants
--     where table_schema = 'public'
--       and table_name = 'pending_recommendations'
--       and grantee in ('authenticated', 'service_role')
--     order by grantee, privilege_type;
-- Expect: authenticated DELETE/SELECT; service_role SELECT. No INSERT rows.

-- Column-level INSERT grant (the client-suppliable columns, nothing else):
--     select column_name
--     from information_schema.role_column_grants
--     where table_schema = 'public'
--       and table_name = 'pending_recommendations'
--       and grantee = 'authenticated'
--       and privilege_type = 'INSERT'
--     order by column_name;
-- Expect exactly: from_user_id, media_type, note, tmdb_id
-- (no id, token, created_at, claimed_by, claimed_at).

-- Kind CHECK widened:
--     select pg_get_constraintdef(oid)
--     from pg_constraint
--     where conname = 'notifications_kind_check'
--       and conrelid = 'public.notifications'::regclass;
-- Expect the 15-kind list ending with 'rec_claimed'.

-- RPC grant:
--     select has_function_privilege(
--         'authenticated',
--         'public.claim_pending_recommendation(text)',
--         'execute');
-- Expect: true.

-- Token default wired to the generator:
--     select column_default
--     from information_schema.columns
--     where table_schema = 'public'
--       and table_name = 'pending_recommendations'
--       and column_name = 'token';
-- Expect: generate_invite_token().
