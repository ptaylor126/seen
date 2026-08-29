-- Profile bio — a short self-description on the profile card.
--
-- Nullable by design: "no bio" is NULL, never an empty string (the edit UI
-- normalises empty input to NULL on save). New signups get NULL untouched —
-- handle_new_user inserts named columns only (id, handle, display_name), so
-- the trigger needs no change; verified post-apply that its definition does
-- not mention bio.
--
-- Length: 160 (the one-to-two-line bio register; Instagram is 150, X 160),
-- deliberately distinct from the 500-char note/comment class. The CHECK
-- mirrors the client-side maxLength so client and server agree — same
-- convention as profiles_display_name_length_check.
--
-- RLS: none needed. The authenticated grant is table-wide and
-- profiles_select_active gates rows, not columns — bio is readable by
-- exactly whoever can already read the profile row (any signed-in,
-- non-blocked user; the handle-search visibility model).
--
-- APPLIED DIRECTLY via the SQL editor on 2026-08-16 (remote migration
-- history is untracked past 20260616130000 — a `db push` would try to
-- replay everything since). This file is the repo record.

alter table public.profiles
    add column bio text
    constraint profiles_bio_length_check
        check (bio is null or char_length(bio) <= 160);
