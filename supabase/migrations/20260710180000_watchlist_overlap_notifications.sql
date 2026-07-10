-- RECORD ONLY — applied by hand in the Supabase dashboard on 2026-07-10 and
-- verified (both triggers firing, rows accruing with the direction-dependent
-- read state, kind check at 14, unread_count exclusion live,
-- items_title_status_idx in place). This file is the repo record; do NOT
-- re-apply or run via the CLI.
--
-- "Overlap prompt" (chat-about-it 3b), DB side: a persistent, quiet
-- watchlist_overlap notification row per (user, title), maintained by two
-- items triggers:
--
--   FORWARD — I add a title to my watchlist that friends have watched. I saw
--   the in-app banner at add time (client-side detection), so the row is
--   informational history: inserted/updated with read_at = now(). NEVER dots.
--
--   REVERSE — a friend marks watched (friends-visible) a title on my
--   watchlist. I had no live signal, so the row is inserted unread — and an
--   update of an existing row RESETS read_at to null. The reverse event
--   earns the dot each time.
--
-- DEDUP: ONE row per (user, kind='watchlist_overlap', title). Updates
-- accumulate the watcher set in the payload; created_at is NOT bumped (the
-- row keeps its original position in the inbox).
--
-- BELL: watchlist_overlap is excluded from unread_count (§5) — the unread
-- reverse row dots the inbox list (the dot mechanism is the inbox's
-- pre-sweep unread fetch, independent of the RPC) but never inflates the
-- bell number. The inbox's kind-unfiltered mark-read sweep clears it on
-- first view.
--
-- PRIVACY (mirrors the title page's friend-activity contract): only
-- watchers whose item is status='watched' AND visibility='friends' count;
-- only actual friends (friendships join — blocking auto-unfriends, so
-- blocked pairs never match); a PRIVATE watch fires nothing. Accepted, noted:
-- a later flip-to-private does NOT retract an already-written row —
-- consistent with rec_watched's non-retraction. Likewise a visibility flip
-- private→friends on an already-watched item does not fire (the triggers
-- gate on STATUS transitions, not visibility changes) — accepted noise
-- avoidance.
--
-- POST-WATCHED-SHEET GUC INTERPLAY (checked, not relevant): the
-- app.skip_rec_watched suppress GUC exists so the rec SENDER isn't
-- double-notified when the sheet posts a comment instead of a rec_watched
-- ping. The reverse trigger here notifies a DIFFERENT audience (watchlist-
-- holding friends, not the rec sender), and fires on the items STATUS
-- transition — which happens in the action-sheet upsert, a separate
-- transaction from mark_recommendation_watched's GUC scope (the sheet's
-- later applyWatchedRating touches items.rating only, status watched →
-- watched, so the trigger skips it). No suppression needed or possible.

-- ============================================================================
-- (0) index — both triggers scan items by title+status on every transition
-- into watchlist/watched; items had no index on that shape (only the
-- (user_id, tmdb_id, media_type) unique). Cheap insurance now, required at
-- scale.
-- ============================================================================

create index if not exists items_title_status_idx
    on public.items (tmdb_id, media_type, status);

-- ============================================================================
-- (1) notifications kind CHECK — widen to include watchlist_overlap.
--
-- LIVE OBJECT — verify before running. Fetch the CURRENT live definition:
--
--     select pg_get_constraintdef(oid)
--     from pg_constraint
--     where conname = 'notifications_kind_check';
--
-- Expected (last widened by 20260709180000): the thirteen kinds
-- rec_received, rec_watched, friend_request, friend_accepted, rec_reacted,
-- rec_commented, comment_reacted, rec_declined, rec_requested, report_filed,
-- chat_commented, chat_reacted, chat_comment_reacted. If the live output
-- lists anything ELSE, STOP and reconcile first (the create-or-replace
-- lesson).
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
        'watchlist_overlap'
    ));

-- ============================================================================
-- (2) FORWARD trigger — transition INTO status='watchlist'.
-- Recomputes the FULL friends-watched set for the title (same shape the
-- banner query uses client-side) and writes it into the one dedup row.
-- read_at = now() unconditionally — the user just saw the banner, so even a
-- previously-unread row (from an earlier reverse event) is considered
-- delivered.
-- ============================================================================

create or replace function public.notify_watchlist_overlap_on_add()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_watchers uuid[];
    v_count integer;
    v_existing_id uuid;
begin
    -- Only transitions INTO watchlist: INSERT with watchlist, or UPDATE
    -- from another status. Everything else exits on two cheap comparisons.
    if new.status <> 'watchlist' then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.status = 'watchlist' then
        return null;
    end if;

    -- Friends of the holder who have watched this title, friends-visible.
    -- Mirrors the title page's friend-activity query; the friendships join
    -- is the block gate too (blocking auto-unfriends).
    select array_agg(i.user_id), count(*)
      into v_watchers, v_count
      from public.items i
     where i.tmdb_id = new.tmdb_id
       and i.media_type = new.media_type
       and i.status = 'watched'
       and i.visibility = 'friends'
       and i.user_id <> new.user_id
       and exists (
           select 1
             from public.friendships f
            where f.user_a_id = least(new.user_id, i.user_id)
              and f.user_b_id = greatest(new.user_id, i.user_id)
       );

    if v_count is null or v_count = 0 then
        return null;
    end if;

    select id into v_existing_id
      from public.notifications
     where user_id = new.user_id
       and kind = 'watchlist_overlap'
       and payload->>'tmdb_id' = new.tmdb_id::text
       and payload->>'media_type' = new.media_type
     limit 1;

    if v_existing_id is null then
        insert into public.notifications (user_id, kind, payload, read_at)
        values (
            new.user_id,
            'watchlist_overlap',
            jsonb_build_object(
                'tmdb_id', new.tmdb_id,
                'media_type', new.media_type,
                'watcher_ids', to_jsonb(v_watchers),
                'watcher_count', v_count
            ),
            now()
        );
    else
        -- Update-in-place: fresh full watcher set; created_at untouched;
        -- read per the forward rule.
        update public.notifications
           set payload = jsonb_build_object(
                   'tmdb_id', new.tmdb_id,
                   'media_type', new.media_type,
                   'watcher_ids', to_jsonb(v_watchers),
                   'watcher_count', v_count
               ),
               read_at = now()
         where id = v_existing_id;
    end if;

    return null;
end;
$$;

create trigger items_notify_watchlist_overlap_add
    after insert or update on public.items
    for each row execute function public.notify_watchlist_overlap_on_add();

-- ============================================================================
-- (3) REVERSE trigger — transition INTO status='watched' with
-- visibility='friends'. One row per watchlist-holding friend: insert unread,
-- or update-in-place APPENDING this watcher to the set (deduped) and
-- resetting read_at to null — the reverse event earns the dot each time.
-- A private watch fires nothing (visibility guard). Re-watch after un-watch
-- fires again — same accepted semantics as rec_watched.
-- ============================================================================

create or replace function public.notify_watchlist_overlap_on_watch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
    v_existing record;
    v_ids jsonb;
begin
    -- Only transitions INTO watched. Rating-only updates (watched → watched)
    -- exit on the second comparison; non-watched writes on the first.
    if new.status <> 'watched' then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.status = 'watched' then
        return null;
    end if;
    if new.visibility is distinct from 'friends' then
        return null;
    end if;

    for r in
        select w.user_id as holder_id
          from public.items w
         where w.tmdb_id = new.tmdb_id
           and w.media_type = new.media_type
           and w.status = 'watchlist'
           and w.user_id <> new.user_id
           and exists (
               select 1
                 from public.friendships f
                where f.user_a_id = least(new.user_id, w.user_id)
                  and f.user_b_id = greatest(new.user_id, w.user_id)
           )
    loop
        select id, payload into v_existing
          from public.notifications
         where user_id = r.holder_id
           and kind = 'watchlist_overlap'
           and payload->>'tmdb_id' = new.tmdb_id::text
           and payload->>'media_type' = new.media_type
         limit 1;

        if v_existing.id is null then
            insert into public.notifications (user_id, kind, payload)
            values (
                r.holder_id,
                'watchlist_overlap',
                jsonb_build_object(
                    'tmdb_id', new.tmdb_id,
                    'media_type', new.media_type,
                    'watcher_ids', jsonb_build_array(new.user_id),
                    'watcher_count', 1
                )
            );
        else
            -- Append this watcher if absent (jsonb ? checks top-level array
            -- membership for text elements); count follows the array.
            v_ids := coalesce(v_existing.payload->'watcher_ids', '[]'::jsonb);
            if not (v_ids ? new.user_id::text) then
                v_ids := v_ids || to_jsonb(new.user_id);
            end if;
            update public.notifications
               set payload = jsonb_build_object(
                       'tmdb_id', new.tmdb_id,
                       'media_type', new.media_type,
                       'watcher_ids', v_ids,
                       'watcher_count', jsonb_array_length(v_ids)
                   ),
                   read_at = null
             where id = v_existing.id;
        end if;
    end loop;

    return null;
end;
$$;

create trigger items_notify_watchlist_overlap_watch
    after insert or update on public.items
    for each row execute function public.notify_watchlist_overlap_on_watch();

-- ============================================================================
-- (4) unread_count — exclude watchlist_overlap from the bell number.
--
-- LIVE OBJECT — verify before running:
--
--     select pg_get_functiondef('public.unread_count(uuid)'::regprocedure);
--
-- Expected: the 20260702120000 body verbatim. If it differs, STOP and
-- reconcile. Body below is that definition with ONE change: the kind
-- exclusion list. create-or-replace preserves the existing EXECUTE grants
-- (authenticated + service_role), so no re-grant is needed.
-- ============================================================================

create or replace function public.unread_count(p_uid uuid)
returns integer
language plpgsql
security definer
set search_path = public
stable
as $$
declare
    v_caller uuid := auth.uid();
    v_total  integer;
begin
    -- JWT caller may only ask about themselves; service_role (uid NULL) is free.
    if v_caller is not null and v_caller <> p_uid then
        raise exception 'unread_count: not authorised for another user';
    end if;

    select
        (select count(*) from public.notifications n
           where n.user_id = p_uid
             and n.read_at is null
             and n.kind not in ('rec_received', 'watchlist_overlap'))
      + (select count(*) from public.friend_requests fr
           where fr.to_user_id = p_uid)
      + (select count(*) from public.recommendations r
           where r.to_user_id = p_uid
             and r.status = 'pending'
             and not exists (
                 select 1 from public.items i
                  where i.user_id   = p_uid
                    and i.tmdb_id    = r.tmdb_id
                    and i.media_type = r.media_type))
    into v_total;

    return coalesce(v_total, 0);
end;
$$;
