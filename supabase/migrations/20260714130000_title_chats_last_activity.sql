-- RECORD ONLY — apply by hand in the Supabase SQL editor (dated 2026-07-14).
-- This file mirrors the live database; once applied do NOT re-run, and never
-- `supabase db push`.
--
-- Denormalise last_activity onto title_chats so a chats list can sort by when
-- the pair last SPOKE, not when the chat was started (created_at). Server-
-- derived via a trigger, never client-trusted — same pattern as the schema's
-- other denormalised columns.
--
-- Design (see the chats-list plan):
--   * Column is NOT NULL DEFAULT now(): created_at also defaults to now(), so a
--     brand-new, message-less chat's last_activity equals its creation time and
--     never sorts to the bottom. No read-time COALESCE anywhere.
--   * Trigger fires on INSERT only. NOT on DELETE: rolling back would require a
--     max() recompute per delete, and the only cost of leaving it is a chat
--     whose newest message was deleted sorting slightly high until its next
--     message — imperceptible, self-healing. greatest() keeps it monotonic.
--   * SECURITY DEFINER because authenticated has only select/insert on
--     title_chats (no UPDATE grant) — the stamp must run as the table owner.
--
-- ADDITIVE. Adds one column, one function, one trigger. Alters/drops no
-- existing column, index, policy or trigger; leaves the two partial unique
-- indexes and chat_comments_notify_commented untouched.

-- 1. Column.
alter table public.title_chats
    add column last_activity timestamptz not null default now();

-- 2. One-time backfill: newest comment's created_at, else created_at.
update public.title_chats tc
set last_activity = coalesce(
    (select max(cc.created_at)
       from public.chat_comments cc
      where cc.chat_id = tc.id),
    tc.created_at
);

-- 3. Trigger function — push the parent chat's last_activity forward on a new
--    comment. SECURITY DEFINER (owner) since authenticated can't UPDATE
--    title_chats; greatest() so it never regresses.
create or replace function public.bump_title_chat_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.title_chats
       set last_activity = greatest(last_activity, new.created_at)
     where id = new.chat_id;
    return null;
end;
$$;

-- 4. Trigger — AFTER INSERT only, additive alongside chat_comments_notify_commented.
create trigger chat_comments_bump_last_activity
    after insert on public.chat_comments
    for each row
    execute function public.bump_title_chat_last_activity();

-- ── Verification (run after applying; do NOT trust the editor's "Success") ───
-- (a) column:   select column_name, data_type, is_nullable, column_default
--                 from information_schema.columns
--                where table_schema='public' and table_name='title_chats'
--                  and column_name='last_activity';   -- NO / now()
-- (b) trigger:  select tgname, pg_get_triggerdef(oid) from pg_trigger
--                where tgrelid='public.chat_comments'::regclass
--                  and tgname='chat_comments_bump_last_activity' and not tgisinternal;
-- (c) no nulls: select count(*) from public.title_chats where last_activity is null;  -- 0
-- (c) match:    select count(*) from public.title_chats tc
--                 join lateral (select max(cc.created_at) newest from public.chat_comments cc
--                                where cc.chat_id=tc.id) c on true
--                where c.newest is not null and tc.last_activity <> c.newest;          -- 0
-- (c) fallback: select count(*) from public.title_chats tc
--                where not exists (select 1 from public.chat_comments cc where cc.chat_id=tc.id)
--                  and tc.last_activity <> tc.created_at;                              -- 0
