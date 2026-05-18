-- Rename recommendations.status enum value 'saved' → 'accepted' AND realign
-- set_recommendation_resolved_at() with the four-state lifecycle.
-- TECHNICAL.md §1 / PRD.md §5 — rec lifecycle is now:
--     pending → accepted → watched (or dismissed)
-- and the rec_watched notification fires on (pending|accepted) → watched.
--
-- Safe because the table is empty: verified with `select count(*)` (0 rows)
-- before drafting this migration. No row-level UPDATE is required.

alter table public.recommendations
    drop constraint recommendations_status_check;

alter table public.recommendations
    add constraint recommendations_status_check
    check (status in ('pending', 'accepted', 'watched', 'dismissed'));

-- Under the old lifecycle, `resolved_at` was stamped on any transition off
-- 'pending'. Under the new lifecycle, 'accepted' is still an open rec
-- (PRD §5, TECHNICAL §1), so the trigger must only stamp on true terminal
-- transitions — entering 'watched' or 'dismissed'. The reverse branch
-- (terminal → non-terminal) is defensive: not a path the UI exposes, but
-- it keeps the invariant `resolved_at IS NULL ↔ rec is open` tight.
create or replace function public.set_recommendation_resolved_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.status in ('watched', 'dismissed')
       and old.status not in ('watched', 'dismissed') then
        new.resolved_at := now();
    elsif new.status in ('pending', 'accepted')
          and old.status in ('watched', 'dismissed') then
        new.resolved_at := null;
    end if;
    return new;
end;
$$;
