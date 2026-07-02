-- unread_count(uuid): canonical composite count, the single source of truth for
-- BOTH the in-app bell (src/hooks/use-unread-count.ts) and the push-payload app
-- icon badge (supabase/functions/send-push-notification). Mirrors the bell's
-- composition EXACTLY so badge == bell:
--
--   (1) informational unread notifications — user_id = uid,
--       read_at IS NULL, kind <> 'rec_received'
--       (rec_received is excluded because a received rec is counted once, via
--        branch 3; counting it here too would double-count AND let the
--        inbox-view read sweep clear it.)
--   (2) actionable pending friend requests — friend_requests has NO status
--       column; a row exists iff the request is pending (accept/decline delete
--       it), so this is just the row count for to_user_id = uid.
--   (3) actionable pending recs NOT already in the recipient's library —
--       recommendations with to_user_id = uid and status = 'pending' (the bell's
--       exact predicate; resolved_at exists but the bell keys on status, so we
--       do too), minus any whose (media_type, tmdb_id) is already in items.
--
-- total = (1) + (2) + (3-net-of-library)
--
-- SECURITY DEFINER: runs as the owner so it can read friend_requests / items /
-- notifications / recommendations regardless of the caller's RLS or table
-- grants. This is what lets service_role (the push Edge Function) compute an
-- arbitrary recipient's count with NO friend_requests grant, and lets an
-- authenticated user compute their own count. search_path is pinned to public
-- (advisor guidance — same hardening as set_updated_at in 20260623120000) to
-- close the definer search-path injection hole, and every table is
-- schema-qualified.
--
-- Auth guard: because it's SECURITY DEFINER and takes a uid, a JWT-authenticated
-- caller may only read their OWN count. The service_role runs with no
-- auth.uid() (NULL) and may pass any recipient uid.

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
             and n.kind <> 'rec_received')
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

-- Least privilege: authenticated (own count only, enforced by the guard) and
-- service_role (any uid). No anon, no public.
revoke all on function public.unread_count(uuid) from public;
revoke all on function public.unread_count(uuid) from anon;
grant execute on function public.unread_count(uuid) to authenticated;
grant execute on function public.unread_count(uuid) to service_role;
