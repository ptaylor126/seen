-- RECORD ONLY — applied by hand in the Supabase dashboard on 2026-07-10 and
-- device-verified (PostgREST schema reloaded — the new columns are written
-- by the API). This file is the repo record; do NOT re-apply or run via the
-- CLI.
--
-- Make comment reactions live. The comment-reaction tables were excluded
-- from the realtime pass (20260710120000) because they had no thread-id
-- column to filter a subscription on. Fix: denormalize the thread id onto
-- each table (chat_id / recommendation_id, copied from the parent comment),
-- backfill, then add both tables to the publication. Each screen adds one
-- more binding — its own channel, per the recorded channel-per-binding
-- lesson in use-thread-realtime (two bindings sharing a filter string on one
-- channel silently drop the second's events).
--
-- Integrity: the column is SERVER-DERIVED. BEFORE INSERT OR UPDATE triggers
-- (§3) set it from the parent comment row, overriding whatever the client
-- sends — the client write paths still populate it (harmless, types read
-- better), but the server value wins. OR UPDATE because the upsert's
-- conflict path sends the column in its UPDATE set-list, which would
-- otherwise be a drift hole. A dangling comment_id can't slip through
-- either way (the comment_id FK rejects it).
--
-- Event-delivery caveats carried over from 20260710120000: DELETE events on
-- filtered subscriptions may not deliver (reaction removals reconcile on the
-- next reload), and RLS (the *_unblocked comment-party SELECT policies) is
-- the delivery boundary — the eq filter is efficiency.

-- ============================================================================
-- (1) chat_comment_reactions.chat_id
-- ============================================================================

alter table public.chat_comment_reactions
    add column chat_id uuid references public.title_chats(id) on delete cascade;

-- Backfill from the parent comment. Every reaction has a live parent
-- (comment_id FK is ON DELETE CASCADE), so this covers every row.
update public.chat_comment_reactions r
set chat_id = c.chat_id
from public.chat_comments c
where c.id = r.comment_id
  and r.chat_id is null;

alter table public.chat_comment_reactions
    alter column chat_id set not null;

-- ============================================================================
-- (2) recommendation_comment_reactions.recommendation_id
-- ============================================================================

alter table public.recommendation_comment_reactions
    add column recommendation_id uuid
        references public.recommendations(id) on delete cascade;

update public.recommendation_comment_reactions r
set recommendation_id = c.recommendation_id
from public.recommendation_comments c
where c.id = r.comment_id
  and r.recommendation_id is null;

alter table public.recommendation_comment_reactions
    alter column recommendation_id set not null;

-- ============================================================================
-- (3) server-derived thread id — BEFORE INSERT OR UPDATE triggers copy the
-- parent comment's thread id onto the row, overriding the client value.
-- SECURITY DEFINER (matching the notify-trigger pattern) so the parent
-- lookup doesn't depend on the caller's RLS view; it only copies the parent's
-- thread id onto the caller's own row — no data exposure. If the parent
-- comment doesn't exist the lookup leaves the value untouched and the
-- comment_id FK rejects the write anyway.
-- ============================================================================

create or replace function public.set_chat_comment_reaction_chat_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    select c.chat_id into new.chat_id
    from public.chat_comments c
    where c.id = new.comment_id;
    return new;
end;
$$;

create trigger chat_comment_reactions_set_chat_id
    before insert or update on public.chat_comment_reactions
    for each row execute function public.set_chat_comment_reaction_chat_id();

create or replace function public.set_rec_comment_reaction_rec_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    select c.recommendation_id into new.recommendation_id
    from public.recommendation_comments c
    where c.id = new.comment_id;
    return new;
end;
$$;

create trigger recommendation_comment_reactions_set_rec_id
    before insert or update on public.recommendation_comment_reactions
    for each row execute function public.set_rec_comment_reaction_rec_id();

-- ============================================================================
-- (4) publication membership — guarded, matching 20260710120000's pattern.
-- ============================================================================

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'chat_comment_reactions'
    ) then
        alter publication supabase_realtime
            add table public.chat_comment_reactions;
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'recommendation_comment_reactions'
    ) then
        alter publication supabase_realtime
            add table public.recommendation_comment_reactions;
    end if;
end $$;
