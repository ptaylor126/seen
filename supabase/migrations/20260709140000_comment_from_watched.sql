-- RECORD ONLY — already applied by hand in the Supabase dashboard on
-- 2026-07-09 (column verified, PostgREST schema reloaded). This file exists so
-- the repo matches live; do NOT re-apply.
--
-- Distinguish comments that originated from the post-watched sheet (a Watched
-- transition, carrying the rating / "I gave it ★★★★" line) from ordinary typed
-- thread comments. The rec thread shows a quiet "watched" status line under the
-- commenter's name for these rows only.
--
-- Mirrors the is_decline_note pattern (20260621130000): a NOT NULL DEFAULT false
-- flag column, so every existing comment keeps its current (plain-comment)
-- rendering. The sheet's postRecComment call sets from_watched = true; the typed
-- composer leaves it at the default.
--
-- No trigger or policy change. The comments INSERT policy
-- (comments_insert_self_if_party: user_id = auth.uid() AND is_party_to_rec)
-- already authorises the author to write this column on their own comment;
-- setting it has no security/privacy impact (display-only).

alter table public.recommendation_comments
    add column from_watched boolean not null default false;
