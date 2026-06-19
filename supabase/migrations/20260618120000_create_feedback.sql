-- Feedback table + private screenshot bucket for the in-app "Send
-- feedback" feature (Profile → Send feedback → submit-feedback Edge
-- Function).
--
-- public.feedback holds the submission. The submit-feedback function
-- inserts through an RLS-scoped client (so user_id defaults to
-- auth.uid()) and emails the maintainer. Users may only INSERT their own
-- feedback — there is NO client SELECT/UPDATE/DELETE: feedback is
-- write-only from the app's perspective; the maintainer reads it via the
-- dashboard / service_role (which bypasses RLS).
--
-- The 'feedback' storage bucket is PRIVATE (mirrors the avatars bucket's
-- structure, but public = false): screenshots can contain anything on
-- the user's screen, so they are never publicly readable. Upload is
-- owner-folder-scoped like avatars; reads happen only via service-role
-- signed URLs minted in the Edge Function.

-- ============================================================================
-- Table
-- ============================================================================

create table public.feedback (
    id uuid primary key default gen_random_uuid(),
    -- on delete set null: keep the feedback even if the account is later
    -- deleted (the text is still useful); default auth.uid() so the
    -- RLS-scoped insert stamps the author without the client passing it.
    user_id uuid references auth.users (id) on delete set null default auth.uid(),
    body text not null,
    screenshot_path text,
    app_version text,
    device text,
    -- Lightweight triage state for the maintainer (new → triaged/done).
    -- Client never reads or writes it; default keeps every fresh row 'new'.
    status text not null default 'new',
    created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- INSERT only: an authenticated user may create feedback rows for
-- themselves. WITH CHECK ties the row to the caller; combined with the
-- user_id default it's belt-and-braces (an explicit user_id that isn't
-- the caller's is rejected).
create policy "feedback_insert_own"
    on public.feedback
    for insert
    to authenticated
    with check (user_id = auth.uid());

-- No SELECT / UPDATE / DELETE policies for users by design — feedback is
-- write-only from the client. service_role bypasses RLS for the
-- maintainer-side read (dashboard / Edge Function).

-- ============================================================================
-- Table privileges
--
-- Matches the pattern in
-- 20260519102336_grant_authenticated_privileges_on_public_tables.sql:
-- RLS gates which rows, but the authenticated role still needs the
-- table-level grant or every insert hits permission denied (42501)
-- before RLS ever runs.
-- ============================================================================

-- feedback: INSERT only. No SELECT/UPDATE/DELETE grant — users never read
-- their feedback back; the maintainer reads via service_role.
grant insert on table public.feedback to authenticated;

-- ============================================================================
-- Storage bucket — private 'feedback'
--
-- Mirrors 20260604120000_create_avatars_bucket.sql in structure, with
-- two deliberate differences: public = false (private), and a larger
-- file_size_limit (feedback screenshots are resized to a ~1600px longest
-- edge vs avatars' 256px square, so they need more headroom).
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'feedback',
    'feedback',
    false,
    -- 5 MB. The feedback pipeline re-encodes to JPEG at a ~1600px longest
    -- edge; this blocks pathological uploads while comfortably fitting a
    -- full-resolution screenshot JPEG (avatars' 512 KB cap would reject
    -- many legitimate screenshots).
    5242880,
    array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Owner-folder-scoped INSERT, same pattern as avatars: the caller's
-- auth.uid() must be the first path segment ({uid}/{uuid}.jpg).
create policy "feedback_insert_own_folder"
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'feedback'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- No public SELECT policy — the bucket is private; the Edge Function
-- mints short-lived signed URLs with the service role. No UPDATE/DELETE
-- policies either: feedback screenshots are never edited or user-deleted
-- (orphans are acceptable; service_role can reap them if ever needed).
