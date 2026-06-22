-- Content reports table for App Store Guideline 1.2 (user-generated content).
--
-- A user can flag objectionable content — a recommendation note, a comment,
-- a review, or a user profile — which writes one row here. The maintainer
-- reads + acts on reports via the dashboard (service_role bypasses RLS);
-- there is no in-app moderation UI yet.
--
-- Mirrors the public.feedback pattern (20260618120000): write-only from the
-- client. Users may only INSERT their own reports — there is NO client
-- SELECT/UPDATE/DELETE. Reports can name another user, so exposing reads to
-- authenticated users would leak who-reported-whom; only service_role reads.
--
-- This migration touches ONLY the new reports table. Blocking (hiding a
-- reported user's content) is a separate task and is deliberately not here.

-- ============================================================================
-- Table
-- ============================================================================

create table public.reports (
    id uuid primary key default gen_random_uuid(),
    -- on delete set null: keep the report even if the reporter later deletes
    -- their account (the report is still actionable); default auth.uid() so
    -- the RLS-scoped insert stamps the reporter without the client passing it.
    reporter_id uuid references auth.users (id) on delete set null default auth.uid(),
    -- What kind of content this points at. Kept as a free text column with a
    -- CHECK rather than an enum so adding a type later is a one-line change.
    reported_type text not null
        check (reported_type in ('recommendation', 'comment', 'review', 'profile')),
    -- The reported content's id (recommendation / comment / review id, or the
    -- profile/user id for a 'profile' report).
    reported_id uuid not null,
    -- Denormalized author of the reported content, so acting on a report
    -- (find the user, eject them) needs no join back to the content table.
    -- Nullable: e.g. a comment whose author was already deleted.
    reported_user_id uuid,
    -- Optional reason the reporter picked (Spam / Harassment / Inappropriate /
    -- Other). Free text so it isn't locked to today's option set.
    reason text,
    -- Lightweight triage state for the maintainer (new -> reviewed/actioned/
    -- dismissed). Client never reads or writes it; default keeps rows 'new'.
    status text not null default 'new',
    created_at timestamptz not null default now()
);

create index reports_status_idx on public.reports (status);

alter table public.reports enable row level security;

-- INSERT only: an authenticated user may create reports stamped to
-- themselves. WITH CHECK ties the row to the caller; combined with the
-- reporter_id default it's belt-and-braces (an explicit reporter_id that
-- isn't the caller's is rejected).
create policy "reports_insert_own"
    on public.reports
    for insert
    to authenticated
    with check (reporter_id = auth.uid());

-- No SELECT / UPDATE / DELETE policies for users by design — reports are
-- write-only from the client (they name other users; reads would leak the
-- reporter↔reported relationship). service_role bypasses RLS for the
-- maintainer-side read + action (dashboard).

-- ============================================================================
-- Table privileges
--
-- RLS gates which rows, but the authenticated role still needs the
-- table-level grant or every insert hits permission denied (42501) before
-- RLS ever runs. INSERT only — no SELECT/UPDATE/DELETE grant.
-- ============================================================================

grant insert on table public.reports to authenticated;
