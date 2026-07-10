-- RECORD / TO APPLY BY HAND — run in the Supabase dashboard, then this file
-- is the repo record; do NOT re-apply or run via the CLI.
--
-- Add the four thread tables (chat + rec comments/reactions) to the
-- supabase_realtime publication so open thread screens can go live: the chat
-- screen subscribes per-chat (chat_id filter) and the rec screen per-rec
-- (recommendation_id filter), each event triggering a silent load() refetch.
-- All four are added NOW so the rec-screen rollout step is client-only.
--
-- Security: these are postgres_changes subscriptions — the realtime server
-- checks every INSERT/UPDATE event against the SUBSCRIBER's SELECT policies
-- (their JWT), and those are the block-aware party policies
-- (is_party_to_chat_unblocked / is_party_to_rec_unblocked), so a non-party —
-- including a blocked ex-party — receives nothing. The client-side eq filter
-- is efficiency, not the security boundary. Known caveat: DELETE events are
-- NOT RLS-filtered and carry only the old primary key (an opaque uuid, no
-- content) — acceptable exposure.
--
-- NOT added: chat_comment_reactions / recommendation_comment_reactions —
-- no chat_id/recommendation_id column to filter on, so a subscription would
-- be table-wide; comment-reaction chips refresh via the screens' focus /
-- foreground / any-other-event reloads instead (deferred by design).
--
-- Guarded so re-running is a no-op (matches 20260603120000 / 20260620130000
-- / 20260703120000).

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'chat_comments'
    ) then
        alter publication supabase_realtime add table public.chat_comments;
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'chat_reactions'
    ) then
        alter publication supabase_realtime add table public.chat_reactions;
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'recommendation_comments'
    ) then
        alter publication supabase_realtime
            add table public.recommendation_comments;
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'recommendation_reactions'
    ) then
        alter publication supabase_realtime
            add table public.recommendation_reactions;
    end if;
end $$;
