-- RECORD ONLY — to be applied by hand in the Supabase dashboard. This file is
-- the repo record of that change; do NOT expect the CLI to run it.
--
-- Watched-sheet comments should read as "watched", not "commented". A comment
-- posted from the post-watched sheet carries from_watched = true (added in
-- 20260709140000). Because the sheet suppresses the plain rec_watched
-- notification for that rec (one action = one notification), the rec_commented
-- row is the ONLY notification the recipient gets — so it must be able to say
-- "watched".
--
-- Change: notify_recommendation_commented() now includes 'from_watched' in the
-- rec_commented payload, so the inbox render and the push copy can branch the
-- wording ("X watched {title}") while everything else about the notification —
-- kind, tap route, comment_id, body preview — stays identical. No new kind.
--
-- Body is verbatim from the live function (20260621130000) EXCEPT the added
-- 'from_watched', new.from_watched pair in jsonb_build_object. The
-- comments_notify_commented trigger stays bound (create-or-replace re-binds it).

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
            'media_type', rec.media_type,
            'from_watched', new.from_watched
        )
    );
    return null;
end;
$$;
