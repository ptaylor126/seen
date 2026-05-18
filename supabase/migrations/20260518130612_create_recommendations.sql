-- recommendations + immutability/resolved triggers + send_recommendation RPC
-- TECHNICAL.md §1 (schema), §2 (RLS), §3 (functions)
-- PRD.md §3 (silent thumb credibility signal), §5 (no re-send, anonymise sender on delete)

-- ============================================================================
-- trigger functions
-- ============================================================================

-- Sets resolved_at the first time a row moves off 'pending'. Defensive:
-- reverts resolved_at to NULL if status ever goes back to 'pending'.
create or replace function public.set_recommendation_resolved_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if old.status = 'pending' and new.status <> 'pending' then
        new.resolved_at := now();
    elsif new.status = 'pending' then
        new.resolved_at := null;
    end if;
    return new;
end;
$$;

-- Sender-set fields are immutable once a rec is sent (per spec — "sender
-- cannot edit after send"). Recipient may freely change status,
-- dismiss_reason, rating_thumb, watched_via_rec, resolved_at.
--
-- Exception: the FK on from_user_id is ON DELETE SET NULL for PRD §5
-- anonymisation. In Postgres, referential SET NULL actions run as a normal
-- UPDATE on the child row and fire user-defined BEFORE UPDATE triggers, so
-- a strict immutability check would block account deletion for any user
-- who has ever sent a rec. The fix: permit the non-null → NULL transition
-- on from_user_id only when the session is running as a privileged role
-- (service_role from delete_account, or postgres from the hard-delete
-- cron) — never from `authenticated` or `anon`. This preserves anonymisation
-- without letting a recipient nullify the sender via client UPDATE.
create or replace function public.enforce_recommendation_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    is_privileged boolean := current_user not in ('authenticated', 'anon');
begin
    if new.id is distinct from old.id then
        raise exception 'cannot change id of a recommendation';
    end if;
    if new.from_user_id is distinct from old.from_user_id then
        if not (is_privileged
                and old.from_user_id is not null
                and new.from_user_id is null) then
            raise exception 'cannot change from_user_id of a recommendation';
        end if;
    end if;
    if new.to_user_id is distinct from old.to_user_id then
        raise exception 'cannot change to_user_id of a recommendation';
    end if;
    if new.tmdb_id is distinct from old.tmdb_id then
        raise exception 'cannot change tmdb_id of a recommendation';
    end if;
    if new.media_type is distinct from old.media_type then
        raise exception 'cannot change media_type of a recommendation';
    end if;
    if new.note is distinct from old.note then
        raise exception 'cannot change note of a recommendation';
    end if;
    if new.sent_at is distinct from old.sent_at then
        raise exception 'cannot change sent_at of a recommendation';
    end if;
    return new;
end;
$$;

-- ============================================================================
-- recommendations
-- ============================================================================

create table public.recommendations (
    id uuid primary key default gen_random_uuid(),
    from_user_id uuid references public.profiles(id) on delete set null,
    to_user_id uuid not null references public.profiles(id) on delete cascade,
    tmdb_id integer not null,
    media_type text not null,
    note text,
    status text not null default 'pending',
    dismiss_reason text,
    rating_thumb text,
    watched_via_rec boolean not null default false,
    sent_at timestamptz not null default now(),
    resolved_at timestamptz,
    constraint recommendations_media_type_check
        check (media_type in ('movie', 'tv')),
    constraint recommendations_status_check
        check (status in ('pending', 'watched', 'dismissed', 'saved')),
    constraint recommendations_note_length_check
        check (note is null or char_length(note) <= 500),
    constraint recommendations_dismiss_reason_only_when_dismissed_check
        check (status = 'dismissed' or dismiss_reason is null),
    constraint recommendations_rating_thumb_value_check
        check (rating_thumb is null or rating_thumb in ('up', 'down')),
    constraint recommendations_rating_thumb_only_when_watched_check
        check (rating_thumb is null or status = 'watched'),
    constraint recommendations_no_self_check
        check (from_user_id is null or from_user_id <> to_user_id),
    constraint recommendations_pair_unique
        unique (from_user_id, to_user_id, tmdb_id, media_type)
);

create index recommendations_to_user_status_idx
    on public.recommendations (to_user_id, status);
create index recommendations_from_user_status_idx
    on public.recommendations (from_user_id, status);

create trigger recommendations_enforce_immutability
    before update on public.recommendations
    for each row execute function public.enforce_recommendation_immutability();

create trigger recommendations_set_resolved_at
    before update on public.recommendations
    for each row execute function public.set_recommendation_resolved_at();

alter table public.recommendations enable row level security;

-- ============================================================================
-- policies
-- ============================================================================

-- SELECT: sender or recipient
create policy "recommendations_select_party"
    on public.recommendations
    for select
    to authenticated
    using (
        from_user_id = (select auth.uid())
        or to_user_id = (select auth.uid())
    );

-- INSERT: only as sender, only to a friend. Re-send is blocked by the
-- unique (from_user_id, to_user_id, tmdb_id, media_type) constraint.
create policy "recommendations_insert_self_to_friend"
    on public.recommendations
    for insert
    to authenticated
    with check (
        from_user_id = (select auth.uid())
        and public.is_friend_of_auth(to_user_id)
    );

-- UPDATE: recipient only. Per-column immutability is enforced by the
-- BEFORE UPDATE trigger; the policy here gates who can touch the row.
create policy "recommendations_update_recipient"
    on public.recommendations
    for update
    to authenticated
    using (to_user_id = (select auth.uid()))
    with check (to_user_id = (select auth.uid()));

-- DELETE: no client policy. Recommendations are not user-deletable.
-- Account deletion handles cleanup via to_user_id cascade and the
-- from_user_id ON DELETE SET NULL anonymisation (PRD §5).

-- ============================================================================
-- send_recommendation RPC
-- ============================================================================

-- Server-side wrapper for the INSERT. Performs the same checks as the
-- INSERT policy (sender = auth.uid, friend recipient) plus argument
-- validation, and returns the new row id. The RLS policy stays in place
-- as defence in depth for any direct INSERTs the app might do later.
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

    -- TODO: insert notification (kind='rec_received') for recipient once
    -- the notifications table exists.

    return new_id;
end;
$$;
