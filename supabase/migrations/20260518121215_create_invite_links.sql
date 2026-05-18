-- invite_links + token generator + extended signup trigger
-- TECHNICAL.md §1 (schema), §2 (RLS)

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- invite_links
-- ============================================================================

create table public.invite_links (
    user_id uuid primary key references public.profiles(id) on delete cascade,
    token text not null,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create unique index invite_links_token_active_key
    on public.invite_links (token)
    where revoked_at is null;

alter table public.invite_links enable row level security;

-- SELECT: own row only
create policy "invite_links_select_own"
    on public.invite_links
    for select
    to authenticated
    using (user_id = (select auth.uid()));

-- UPDATE: own row only (used for token regeneration)
create policy "invite_links_update_own"
    on public.invite_links
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- INSERT: no policy. Created by the signup trigger (security definer
-- bypasses RLS).
-- DELETE: no policy. Removed via auth.users cascade or the future account
-- deletion Edge Function (service_role).

-- ============================================================================
-- token generator
-- ============================================================================

-- 12 random bytes -> 16 base64 chars (no padding), then translate to
-- URL-safe alphabet: '+' -> '-', '/' -> '_', '=' dropped. Result is exactly
-- 16 chars of base64url. ~96 bits of entropy, ample for invite tokens.
create or replace function public.generate_invite_token()
returns text
language sql
volatile
set search_path = public
as $$
    select substring(
        translate(
            encode(extensions.gen_random_bytes(12), 'base64'),
            '+/=',
            '-_'
        ),
        1, 16
    );
$$;

-- ============================================================================
-- extend handle_new_user() to also create an invite_links row
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, handle, display_name)
    values (
        new.id,
        'user_' || substring(replace(new.id::text, '-', ''), 1, 12),
        'New user'
    );

    insert into public.invite_links (user_id, token)
    values (new.id, public.generate_invite_token());

    return new;
end;
$$;
