-- Notify the SENDER when a recipient declines their recommendation WITH a
-- note. Mirrors notify_recommendation_watched: a SECURITY DEFINER AFTER
-- UPDATE trigger on recommendations that inserts a row into
-- public.notifications (which the existing notifications-INSERT webhook
-- fans out to push, and the inbox renders).
--
-- SILENT-STAYS-SILENT: the trigger fires ONLY when dismiss_reason is
-- non-null. A silent decline (status='dismissed', dismiss_reason=null)
-- inserts nothing — no notification row, so no push and nothing in the
-- sender's inbox.
--
-- UNDO-SAFE (deferred): the trigger keys on the dismiss_reason TRANSITION
-- (old.dismiss_reason IS DISTINCT FROM new.dismiss_reason), not on the
-- status flip. The client declines in two steps: (1) on confirm, set
-- status='dismissed' with dismiss_reason=null (no note → no notification);
-- (2) only after the undo window elapses with no undo, a second update
-- sets dismiss_reason=<note>, and THAT transition is what fires this
-- trigger. An undo within the window writes status='pending',
-- dismiss_reason=null, so the note never persists and this never fires.
-- (Unlike rec_watched, there's no fire-then-can't-retract window.)

-- (1) Allow the new notification kind.
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
        'rec_declined'
    ));

-- (2) Trigger function. Recipient (to_user_id) is the actor; the
-- notification goes to the sender (from_user_id). Payload mirrors the
-- other rec notifications (from_user_id = the acting party, so the inbox
-- resolves the decliner's profile the same way) and carries the note.
create or replace function public.notify_recommendation_declined()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status = 'dismissed'
       and new.dismiss_reason is not null
       and old.dismiss_reason is distinct from new.dismiss_reason
       and new.from_user_id is not null then
        insert into public.notifications (user_id, kind, payload)
        values (
            new.from_user_id,
            'rec_declined',
            jsonb_build_object(
                'from_user_id', new.to_user_id,
                'recommendation_id', new.id,
                'tmdb_id', new.tmdb_id,
                'media_type', new.media_type,
                'note', new.dismiss_reason
            )
        );
    end if;
    return null;
end;
$$;

create trigger recommendations_notify_declined
    after update on public.recommendations
    for each row execute function public.notify_recommendation_declined();
