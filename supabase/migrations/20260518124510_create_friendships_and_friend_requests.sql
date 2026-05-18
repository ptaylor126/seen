-- friendships + friend_requests + RPCs (accept/decline/unfriend/claim)
-- TECHNICAL.md §1 (schema), §2 (RLS), §3 (functions)
-- PRD.md §5 (recommendations history survives unfriending)

-- ============================================================================
-- friendships
-- ============================================================================

create table public.friendships (
    user_a_id uuid not null references public.profiles(id) on delete cascade,
    user_b_id uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_a_id, user_b_id),
    constraint friendships_lexicographic_check
        check (user_a_id < user_b_id)
);

create index friendships_user_b_id_idx on public.friendships (user_b_id);

alter table public.friendships enable row level security;

-- SELECT: rows where the caller is either party
create policy "friendships_select_party"
    on public.friendships
    for select
    to authenticated
    using (
        user_a_id = (select auth.uid())
        or user_b_id = (select auth.uid())
    );

-- INSERT/UPDATE/DELETE: no client policies. Mutations go through the
-- accept_friend_request / unfriend / claim_invite_link RPCs below
-- (security definer).

-- ============================================================================
-- friend_requests
-- ============================================================================

create table public.friend_requests (
    id uuid primary key default gen_random_uuid(),
    from_user_id uuid not null references public.profiles(id) on delete cascade,
    to_user_id uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    constraint friend_requests_self_check
        check (from_user_id != to_user_id),
    constraint friend_requests_pair_unique
        unique (from_user_id, to_user_id)
);

create index friend_requests_to_user_id_idx
    on public.friend_requests (to_user_id);

alter table public.friend_requests enable row level security;

-- ============================================================================
-- can_send_friend_request helper
-- ============================================================================

-- Encapsulates the "no existing friendship + no reverse pending request"
-- preconditions for the friend_requests INSERT policy. security definer so
-- it can probe friendships/friend_requests without coupling to their RLS
-- expressions. The return is a single boolean for the (caller, target)
-- pair — both rows the caller can already see under their own RLS — so
-- this is not an information-leak surface.
create or replace function public.can_send_friend_request(target uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
begin
    if me is null or target is null or target = me then
        return false;
    end if;
    if exists (
        select 1 from public.friendships
        where user_a_id = least(me, target)
          and user_b_id = greatest(me, target)
    ) then
        return false;
    end if;
    if exists (
        select 1 from public.friend_requests
        where from_user_id = target and to_user_id = me
    ) then
        return false;
    end if;
    return true;
end;
$$;

-- ============================================================================
-- friend_requests policies
-- ============================================================================

-- SELECT: sender or recipient
create policy "friend_requests_select_party"
    on public.friend_requests
    for select
    to authenticated
    using (
        from_user_id = (select auth.uid())
        or to_user_id = (select auth.uid())
    );

-- INSERT: only as the sender, only when no existing friendship and no
-- reverse pending request. The unique (from_user_id, to_user_id) constraint
-- prevents identical resends. Self-request is blocked by the table CHECK.
create policy "friend_requests_insert_self"
    on public.friend_requests
    for insert
    to authenticated
    with check (
        from_user_id = (select auth.uid())
        and public.can_send_friend_request(to_user_id)
    );

-- DELETE: sender (cancel) or recipient (decline). Accept goes through the
-- accept_friend_request RPC.
create policy "friend_requests_delete_party"
    on public.friend_requests
    for delete
    to authenticated
    using (
        from_user_id = (select auth.uid())
        or to_user_id = (select auth.uid())
    );

-- UPDATE: no policy. No editable fields.

-- ============================================================================
-- accept_friend_request
-- ============================================================================

create or replace function public.accept_friend_request(request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    req record;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;

    select * into req from public.friend_requests where id = request_id;

    if not found then
        raise exception 'friend request not found';
    end if;

    if req.to_user_id != me then
        raise exception 'only the recipient can accept this request';
    end if;

    insert into public.friendships (user_a_id, user_b_id)
    values (
        least(req.from_user_id, req.to_user_id),
        greatest(req.from_user_id, req.to_user_id)
    )
    on conflict do nothing;

    delete from public.friend_requests where id = request_id;

    -- TODO: insert notifications (kind='friend_accepted') for both users
    -- once the notifications table exists.
end;
$$;

-- ============================================================================
-- decline_friend_request
-- ============================================================================

create or replace function public.decline_friend_request(request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    req record;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;

    select * into req from public.friend_requests where id = request_id;

    if not found then
        raise exception 'friend request not found';
    end if;

    if req.to_user_id != me then
        raise exception 'only the recipient can decline this request';
    end if;

    delete from public.friend_requests where id = request_id;
end;
$$;

-- ============================================================================
-- unfriend
-- ============================================================================

-- Deletes the friendship row only. Past recommendations are intentionally
-- preserved (PRD §5: history survives unfriending).
create or replace function public.unfriend(other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    deleted_count int;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;

    if other_user_id is null or other_user_id = me then
        raise exception 'invalid friendship target';
    end if;

    delete from public.friendships
    where user_a_id = least(me, other_user_id)
      and user_b_id = greatest(me, other_user_id);

    get diagnostics deleted_count = row_count;
    if deleted_count = 0 then
        raise exception 'friendship not found';
    end if;
end;
$$;

-- ============================================================================
-- claim_invite_link
-- ============================================================================

-- Claims an invite token: creates a mutual friendship between auth.uid()
-- and the token's owner. Idempotent if the friendship already exists.
-- Supersedes any pending friend_request in either direction.
create or replace function public.claim_invite_link(token text)
returns void
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

    a := least(me, owner_id);
    b := greatest(me, owner_id);

    if exists (
        select 1 from public.friendships
        where user_a_id = a and user_b_id = b
    ) then
        return;
    end if;

    delete from public.friend_requests
    where (from_user_id = me and to_user_id = owner_id)
       or (from_user_id = owner_id and to_user_id = me);

    insert into public.friendships (user_a_id, user_b_id) values (a, b);

    -- TODO: insert notifications (kind='friend_accepted') for both users
    -- once the notifications table exists.
end;
$$;
