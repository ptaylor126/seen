-- Optional reply-to email on feedback submissions.
--
-- A submitter can leave an email if they'd like a reply. Nullable, no
-- default — most feedback is anonymous-to-reply. No RLS change: it rides
-- on the existing insert-only policy (feedback_insert_own) from
-- 20260618120000_create_feedback.sql, and the authenticated INSERT grant
-- already covers the new column.

alter table public.feedback add column reply_email text;
