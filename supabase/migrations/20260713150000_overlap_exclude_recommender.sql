-- RECORD ONLY — applied by hand in the Supabase SQL editor on 2026-07-13.
-- This file mirrors the live database; do NOT re-run.
--
-- Bug: A recommends title X to B; B adds X to their watchlist; the forward
-- watchlist_overlap trigger writes B a row whose watcher_ids include A — the
-- app tells B that A has seen a title A just recommended to them. Same reaches
-- the reverse path (A watches X after B has it on their watchlist).
--
-- Fix (additive — two create-or-replace trigger-function bodies, nothing else
-- changes: same kind, same born-read behaviour on the forward path, same
-- triggers): exclude from watcher_ids any friend who has an ACTIVE
-- (non-dismissed) recommendation of this title to the holder. "Active" =
-- status <> 'dismissed' (recommendations statuses are pending / accepted /
-- watched / dismissed). If excluding the recommender empties the set, the
-- forward path returns early and writes NO row. A dismissed rec does NOT
-- exclude — the recommendation was rejected, so that friend's watch is real
-- overlap signal again.

-- ── FORWARD: transition INTO status='watchlist' ─────────────────────────────
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
    if new.status <> 'watchlist' then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.status = 'watchlist' then
        return null;
    end if;

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
       )
       -- NEW: drop any friend who actively recommended this title to the
       -- holder (non-dismissed) — surfacing the recommender reads as noise.
       and not exists (
           select 1
             from public.recommendations r
            where r.from_user_id = i.user_id
              and r.to_user_id = new.user_id
              and r.tmdb_id = new.tmdb_id
              and r.media_type = new.media_type
              and r.status <> 'dismissed'
       );

    if v_count is null or v_count = 0 then
        return null;   -- no non-recommender watchers → write NO row
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

-- ── REVERSE: transition INTO status='watched' (friends-visible) ─────────────
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
        -- NEW: skip a holder to whom this WATCHER actively recommended the
        -- title (non-dismissed) — same reason as the forward path, and it
        -- keeps the recommender out of an existing row too.
        if exists (
            select 1
              from public.recommendations rec
             where rec.from_user_id = new.user_id
               and rec.to_user_id = r.holder_id
               and rec.tmdb_id = new.tmdb_id
               and rec.media_type = new.media_type
               and rec.status <> 'dismissed'
        ) then
            continue;
        end if;

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
