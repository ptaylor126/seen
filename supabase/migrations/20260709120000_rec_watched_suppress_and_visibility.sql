-- RECORD ONLY — already applied by hand in the Supabase dashboard on
-- 2026-07-09. This file exists so the repo matches live; do NOT re-apply.
--
-- Two changes to the rec_watched pipeline so that "you watched their rec"
-- fires at most once per action and respects privacy:
--
--   1. notify_recommendation_watched() now ALSO skips the rec_watched insert
--      when EITHER a transaction-local GUC (app.skip_rec_watched = 'on') is set
--      OR the recipient has marked the item private (items.visibility =
--      'private' for new.to_user_id / new.tmdb_id / new.media_type). Otherwise
--      identical to the original (20260518150956).
--
--   2. New RPC mark_recommendation_watched(p_rec_id, p_suppress, p_thumb) —
--      SECURITY DEFINER, replacing the earlier two-arg version. When p_suppress,
--      it sets the GUC (local to the transaction), then performs the
--      (status='watched', watched_via_rec=true, rating_thumb=coalesce(p_thumb,
--      rating_thumb)) transition guarded by to_user_id = auth.uid(). The client
--      calls it once per open rec, passing p_suppress = true for senders who are
--      receiving a comment instead (so one action = one notification), and
--      p_thumb = the up/down credibility signal derived from the star rating.
--
-- The recommendations_notify_watched trigger from 20260518150956 is unchanged —
-- create-or-replace on the function re-binds it automatically.
--
-- NOTE: both function bodies below are transcribed verbatim from the live
-- pg_proc.prosrc (2026-07-09). The drop of the two-arg signature and the
-- create-or-replace headers reproduce the applied state; do NOT re-apply.

-- ============================================================================
-- (1) notify_recommendation_watched — original + suppress-GUC + private skip
-- ============================================================================
create or replace function public.notify_recommendation_watched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.status in ('pending', 'accepted')
        and new.status = 'watched'
        and new.from_user_id is not null
        -- suppressed for this transaction (sheet is sending a comment instead)
        and coalesce(current_setting('app.skip_rec_watched', true), '') <> 'on'
        -- respect the recipient's item privacy
        and not exists (
            select 1 from public.items i
            where i.user_id = new.to_user_id
              and i.tmdb_id = new.tmdb_id
              and i.media_type = new.media_type
              and i.visibility = 'private'
        )
    then
        insert into public.notifications (user_id, kind, payload)
        values (
            new.from_user_id,
            'rec_watched',
            jsonb_build_object('to_user_id', new.to_user_id,
                'recommendation_id', new.id, 'tmdb_id', new.tmdb_id,
                'media_type', new.media_type)
        );
    end if;
    return null;
end;
$$;

-- ============================================================================
-- (2) mark_recommendation_watched — suppress-aware watched transition + thumb
-- ============================================================================
-- The original two-arg signature is dropped: adding the defaulted p_thumb param
-- creates a NEW overload rather than replacing, so the old one must be removed.
drop function if exists public.mark_recommendation_watched(uuid, boolean);

create or replace function public.mark_recommendation_watched(
    p_rec_id uuid,
    p_suppress boolean default false,
    p_thumb text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_suppress then
        perform set_config('app.skip_rec_watched', 'on', true);
    end if;
    update public.recommendations
       set status = 'watched',
           watched_via_rec = true,
           rating_thumb = coalesce(p_thumb, rating_thumb)
     where id = p_rec_id
       and to_user_id = auth.uid();
end;
$$;
