-- Decline notes now appear as real comments in the rec thread (so both
-- parties see them like any other message), but a noted decline must NOT
-- double-notify the sender: they're already notified by the rec_declined
-- "passed on" notification (notify_recommendation_declined, 20260620120000).
--
-- Mechanism: mark the decline's comment row with is_decline_note = true.
-- The comment-INSERT notifier skips notifying for those rows, so a noted
-- decline produces exactly ONE notification (rec_declined) plus the note as
-- a visible comment. Normal comments (is_decline_note = false, the default)
-- notify via rec_commented exactly as before.

-- (1) Flag column. NOT NULL DEFAULT false → every existing comment keeps
-- its current (notifying) behaviour.
alter table public.recommendation_comments
    add column is_decline_note boolean not null default false;

-- (2) Re-define the comment-INSERT notifier to skip decline-note comments.
-- Body is identical to 20260605120000 except for the early return.
create or replace function public.notify_recommendation_commented()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    rec public.recommendations%rowtype;
    target uuid;
begin
    -- Decline notes are surfaced as comments for thread visibility, but the
    -- sender is already notified by notify_recommendation_declined — skip
    -- the duplicate rec_commented notification for these.
    if new.is_decline_note then
        return null;
    end if;

    select * into rec from public.recommendations where id = new.recommendation_id;
    if not found then
        return null;
    end if;

    target := case
        when new.user_id = rec.to_user_id then rec.from_user_id
        else rec.to_user_id
    end;
    if target is null or target = new.user_id then
        return null;
    end if;

    insert into public.notifications (user_id, kind, payload)
    values (
        target,
        'rec_commented',
        jsonb_build_object(
            'from_user_id', new.user_id,
            'recommendation_id', new.recommendation_id,
            'comment_id', new.id,
            'tmdb_id', rec.tmdb_id,
            'media_type', rec.media_type
        )
    );
    return null;
end;
$$;

-- No trigger or policy change. The trigger comments_notify_commented stays
-- bound to this (now-replaced) function. The comments INSERT policy
-- (comments_insert_self_if_party: user_id = auth.uid() AND is_party_to_rec)
-- already authorises the recipient to write this column on their own
-- comment; a client setting is_decline_note on a normal comment would only
-- suppress the notification for their OWN message (no security/privacy
-- impact).
