-- profiles + handle_history + auth signup trigger
-- TECHNICAL.md §1 (schema), §2 (RLS)

-- ============================================================================
-- profiles
-- ============================================================================

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    handle text not null,
    display_name text not null,
    avatar_url text,
    handle_changed_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    constraint profiles_handle_format_check
        check (handle ~ '^[a-z0-9_]{3,20}$'),
    constraint profiles_display_name_length_check
        check (char_length(display_name) between 1 and 50)
);

create unique index profiles_handle_key on public.profiles (handle);
create index profiles_deleted_at_idx on public.profiles (deleted_at)
    where deleted_at is not null;

alter table public.profiles enable row level security;

-- SELECT: any authenticated user can read non-deleted profiles
create policy "profiles_select_active"
    on public.profiles
    for select
    to authenticated
    using (deleted_at is null);

-- UPDATE: only owner
create policy "profiles_update_own"
    on public.profiles
    for update
    to authenticated
    using (id = (select auth.uid()))
    with check (id = (select auth.uid()));

-- INSERT: blocked at policy level. The signup trigger runs as security
-- definer and bypasses RLS, so no policy is needed.
-- DELETE: blocked at policy level. Account deletion happens via a future
-- Edge Function running with service_role.

-- ============================================================================
-- handle_history
-- ============================================================================

create table public.handle_history (
    handle text primary key,
    released_at timestamptz not null,
    available_at timestamptz not null default (now() + interval '90 days'),
    constraint handle_history_lowercase_check
        check (handle = lower(handle))
);

alter table public.handle_history enable row level security;

-- No client policies. service_role bypasses RLS; a future Edge Function
-- writes here when a user changes their handle.

-- ============================================================================
-- auth signup trigger
-- ============================================================================

-- Creates a placeholder profile for every new auth user. The onboarding flow
-- overwrites handle and display_name in step 3. invite_links is created in a
-- later migration when that table exists.
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
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
