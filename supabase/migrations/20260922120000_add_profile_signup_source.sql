-- Profile signup source — "How did you hear about Seen?", asked once,
-- optionally, on the handle onboarding screen.
--
-- Nullable by design: "skipped / unknown" is NULL, never an empty string —
-- same convention as bio. New signups get NULL untouched — handle_new_user
-- inserts named columns only (id, handle, display_name), so the trigger
-- needs no change; same reasoning verified for bio applies here (no column
-- list to update).
--
-- Closed enum via CHECK, not free text: this exists purely to learn true
-- acquisition channel (store analytics can't distinguish Reddit/social from
-- search), so the value set must stay small and stable to be aggregable.
-- The client's option list (handle.tsx) must stay in lockstep with this
-- constraint — same convention as profiles_bio_length_check mirroring the
-- client-side maxLength.
--
-- RLS: none needed. Same reasoning as bio — the authenticated grant is
-- table-wide and profiles_select_active gates rows, not columns, so
-- signup_source is readable by exactly whoever can already read the
-- profile row. (Unlike bio, this is more an internal analytics field than
-- a social one — no UI currently surfaces it to other users, but nothing
-- prevents it either; revisit if that becomes a concern.)
--
-- APPLIED DIRECTLY via the SQL editor (remote migration history is
-- untracked past 20260616130000 — a `db push` would try to replay
-- everything since). This file is the repo record.

alter table public.profiles
    add column signup_source text
    constraint profiles_signup_source_check
        check (
            signup_source is null
            or signup_source in (
                'app_store_search',
                'reddit',
                'tiktok',
                'instagram',
                'x',
                'friend',
                'other'
            )
        );
