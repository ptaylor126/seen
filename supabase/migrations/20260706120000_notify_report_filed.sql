-- Push the maintainer when a content report lands.
--
-- Reuses the existing push pipeline exactly: every push in the app flows from
-- an INSERT into public.notifications → the "send_push_on_notification_insert"
-- Database Webhook → send-push-notification (which re-fetches the row by id and
-- fans out to the recipient's push_tokens). So this is just: on a new report,
-- write ONE notifications row for the maintainer with a new kind the push
-- function knows how to format. No pg_net, no direct function call — those
-- wouldn't work anyway, since the function re-fetches a notifications row by id.
--
-- The row is inserted with read_at = now() on purpose: it's a push-only alert.
-- read_at IS NOT NULL means unread_count ignores it (no phantom bell/badge), and
-- the inbox never renders 'report_filed' (not in its RENDER_KINDS) — so nothing
-- clutters the maintainer's in-app feed. The push banner IS the notification.
--
-- Payload carries ONLY reason + reported_type — no reporter identity, so the
-- push body can't name who reported. The maintainer reads full report detail
-- (reporter, reported content) from the Supabase dashboard as before.

-- ============================================================================
-- (1) Allow the new notification kind. Full list re-stated (drop + re-add),
--     matching the pattern of every prior kind-adding migration.
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
        'report_filed'
    ));

-- ============================================================================
-- (2) Trigger function: on a new report, notify the maintainer.
--
-- SECURITY DEFINER so it can (a) read auth.users to resolve the maintainer and
-- (b) insert a notification whose user_id is someone else — both of which the
-- inserting authenticated user is not allowed to do under RLS. search_path
-- pinned to public (definer-injection hardening, same as the other notify
-- triggers). Never raises: a failure to resolve/notify must not block the
-- report insert itself.
--
-- ***** MAINTAINER IDENTITY LIVES HERE *****
-- Resolved by email (paulandhisdocs@gmail.com) rather than a hardcoded uuid so
-- it's human-readable and self-documenting. To change the maintainer, edit the
-- email on the SELECT below (and re-run create-or-replace). Alternative if you
-- prefer a config table: replace the SELECT with a lookup into that table.
-- ============================================================================
create or replace function public.notify_report_filed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_maintainer uuid;
begin
    select id
      into v_maintainer
      from auth.users
     where email = 'paulandhisdocs@gmail.com'
     limit 1;

    -- Maintainer not found (email changed, account gone) → do nothing, and
    -- never block the report from being written.
    if v_maintainer is null then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload, read_at)
    values (
        v_maintainer,
        'report_filed',
        jsonb_build_object(
            'reason', new.reason,
            'reported_type', new.reported_type
        ),
        now()  -- push-only: keep it out of the in-app bell / inbox.
    );

    return null;
end;
$$;

create trigger reports_notify_maintainer
    after insert on public.reports
    for each row
    execute function public.notify_report_filed();
