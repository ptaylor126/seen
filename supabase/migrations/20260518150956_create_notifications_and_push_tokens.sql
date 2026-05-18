-- notifications + push_tokens + notification wiring for the four trigger points
-- TECHNICAL.md §1 (schema), §2 (RLS); PRD.md §4 (notifications drive bell + push)

-- ============================================================================
-- notifications
-- ============================================================================

create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    kind text not null,
    payload jsonb not null default '{}'::jsonb,
    read_at timestamptz,
    created_at timestamptz not null default now(),
    constraint notifications_kind_check
        check (kind in ('rec_received', 'rec_watched', 'friend_request', 'friend_accepted'))
);

create index notifications_user_read_idx
    on public.notifications (user_id, read_at);
create index notifications_user_created_idx
    on public.notifications (user_id, created_at);

alter table public.notifications enable row level security;

-- SELECT: own only
create policy "notifications_select_own"
    on public.notifications
    for select
    to authenticated
    using (user_id = (select auth.uid()));

-- UPDATE: own only (used to set read_at). WITH CHECK keeps the row owned.
create policy "notifications_update_own"
    on public.notifications
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- No INSERT policy: notifications are created by the trigger functions and
-- RPCs below, all of which run as security definer.
-- No DELETE policy: cleanup happens via the profiles cascade.

-- ============================================================================
-- push_tokens
-- ============================================================================

create table public.push_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    expo_push_token text not null,
    platform text not null,
    device_id text not null,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    constraint push_tokens_platform_check
        check (platform in ('ios', 'android')),
    constraint push_tokens_user_device_unique
        unique (user_id, device_id)
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

create policy "push_tokens_select_own"
    on public.push_tokens
    for select
    to authenticated
    using (user_id = (select auth.uid()));

create policy "push_tokens_insert_own"
    on public.push_tokens
    for insert
    to authenticated
    with check (user_id = (select auth.uid()));

create policy "push_tokens_update_own"
    on public.push_tokens
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

create policy "push_tokens_delete_own"
    on public.push_tokens
    for delete
    to authenticated
    using (user_id = (select auth.uid()));

-- ============================================================================
-- new trigger: notify recipient on friend_request INSERT
-- ============================================================================

create or replace function public.notify_friend_request_received()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.notifications (user_id, kind, payload)
    values (
        new.to_user_id,
        'friend_request',
        jsonb_build_object(
            'from_user_id', new.from_user_id,
            'request_id', new.id
        )
    );
    return null;
end;
$$;

create trigger friend_requests_notify_received
    after insert on public.friend_requests
    for each row execute function public.notify_friend_request_received();

-- ============================================================================
-- new trigger: notify sender when a rec moves pending -> watched
-- ============================================================================

-- Fires on (pending | accepted) -> watched transitions, matching the rec
-- lifecycle in TECHNICAL §1 / PRD §5. `accepted` means the recipient added
-- the title to their watchlist with attribution but the rec is still open;
-- when they ultimately watch it, the sender deserves the notification.
-- Anonymised senders (from_user_id IS NULL after account deletion) are
-- skipped because there's no one to deliver to.
create or replace function public.notify_recommendation_watched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.status in ('pending', 'accepted')
       and new.status = 'watched'
       and new.from_user_id is not null then
        insert into public.notifications (user_id, kind, payload)
        values (
            new.from_user_id,
            'rec_watched',
            jsonb_build_object(
                'to_user_id', new.to_user_id,
                'recommendation_id', new.id,
                'tmdb_id', new.tmdb_id,
                'media_type', new.media_type
            )
        );
    end if;
    return null;
end;
$$;

create trigger recommendations_notify_watched
    after update on public.recommendations
    for each row execute function public.notify_recommendation_watched();

-- ============================================================================
-- accept_friend_request — full replacement; now notifies the original sender
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

    -- Notify the original sender that their request was accepted. The
    -- acceptor (me) doesn't need a self-notification — the UI knows they
    -- just tapped accept.
    insert into public.notifications (user_id, kind, payload)
    values (
        req.from_user_id,
        'friend_accepted',
        jsonb_build_object(
            'from_user_id', me,
            'request_id', request_id
        )
    );
end;
$$;

-- ============================================================================
-- claim_invite_link — full replacement; now notifies the link owner
-- ============================================================================

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
        return;  -- idempotent: already friends, no notification
    end if;

    delete from public.friend_requests
    where (from_user_id = me and to_user_id = owner_id)
       or (from_user_id = owner_id and to_user_id = me);

    insert into public.friendships (user_a_id, user_b_id) values (a, b);

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
end;
$$;

-- ============================================================================
-- send_recommendation — full replacement; now notifies the recipient
-- ============================================================================

create or replace function public.send_recommendation(
    to_user_id uuid,
    tmdb_id integer,
    media_type text,
    note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
    me uuid := (select auth.uid());
    new_id uuid;
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    if to_user_id is null or to_user_id = me then
        raise exception 'invalid recipient';
    end if;
    if media_type not in ('movie', 'tv') then
        raise exception 'invalid media_type';
    end if;
    if note is not null and char_length(note) > 500 then
        raise exception 'note too long';
    end if;
    if not public.is_friend_of_auth(to_user_id) then
        raise exception 'recipient is not a friend';
    end if;

    insert into public.recommendations (from_user_id, to_user_id, tmdb_id, media_type, note)
    values (me, to_user_id, tmdb_id, media_type, note)
    returning id into new_id;

    insert into public.notifications (user_id, kind, payload)
    values (
        to_user_id,
        'rec_received',
        jsonb_build_object(
            'from_user_id', me,
            'recommendation_id', new_id,
            'tmdb_id', tmdb_id,
            'media_type', media_type
        )
    );

    return new_id;
end;
$$;
