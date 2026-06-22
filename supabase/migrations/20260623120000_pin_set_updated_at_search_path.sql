-- Pin search_path on set_updated_at().
--
-- set_updated_at (20260518123418_create_items.sql) is the only function in
-- the schema without a pinned search_path. It is NOT security definer, so
-- the classic mutable-search_path → privilege-escalation vector doesn't
-- apply, and its body only touches now()/new.updated_at — but Supabase's
-- security advisor (function_search_path_mutable) flags it, and it's the
-- lone inconsistency against an otherwise rigorously pinned codebase.
-- Pinning it keeps the advisor panel clean ahead of submission.
--
-- ALTER (not CREATE OR REPLACE) so the existing body + all triggers bound
-- to it are untouched — this only sets the function's search_path config.

alter function public.set_updated_at() set search_path = public;
