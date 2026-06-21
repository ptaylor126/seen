-- "Request a recommendation" (v1, untied). A user nudges a friend to send
-- them a rec. There is NO request table and NO status tracking — the nudge
-- is a single notification; the friend responds by sending a normal rec
-- through the existing flow. Linking the eventual rec back to the request is
-- a deliberate later phase.
--
-- notifications has no client INSERT policy (server-side only), so the nudge
-- is created by a SECURITY DEFINER RPC, mirroring send_recommendation: it
-- validates the caller, the friendship, and the note, then inserts a
-- notification addressed to the friend. The existing notifications-INSERT
-- webhook fans it out to push; the inbox renders kind='rec_requested'.

-- (1) Allow the new notification kind. Full list re-stated (drop + re-add),
-- mirroring 20260620120000_notify_recommendation_declined.
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
        'rec_requested'
    ));

-- (2) RPC. The notification goes to the friend (to_user_id); the caller
-- (auth.uid()) is the requester, carried in the payload as from_user_id so
-- the inbox resolves the requester's profile the same way as other kinds.
-- The optional note ("what are you in the mood for") rides in the payload.
create or replace function public.request_recommendation(
    to_user_id uuid,
    note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    me uuid := (select auth.uid());
    clean_note text := nullif(btrim(coalesce(note, '')), '');
begin
    if me is null then
        raise exception 'not authenticated';
    end if;
    if to_user_id is null or to_user_id = me then
        raise exception 'invalid recipient';
    end if;
    if clean_note is not null and char_length(clean_note) > 500 then
        raise exception 'note too long';
    end if;
    -- Same friendship gate as send_recommendation: you can only ask a
    -- confirmed friend.
    if not public.is_friend_of_auth(to_user_id) then
        raise exception 'recipient is not a friend';
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        to_user_id,
        'rec_requested',
        jsonb_build_object(
            'from_user_id', me,
            'note', clean_note
        )
    );
end;
$$;

-- Mirrors the EXECUTE grant pattern on send_recommendation etc. — without
-- it, callers under the authenticated role error 42501.
grant execute on function public.request_recommendation(uuid, text)
    to authenticated;
