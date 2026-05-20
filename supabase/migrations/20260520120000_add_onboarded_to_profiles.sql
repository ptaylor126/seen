-- Add onboarded flag to profiles.
-- New users go through the 6-screen onboarding flow before landing in
-- the main app; subsequent sign-ins skip it. The flag is stored on the
-- profile so the routing logic in src/app/_layout.tsx can branch on
-- it once the initial session resolves.

alter table public.profiles
    add column onboarded boolean not null default false;

-- Backfill existing accounts. Anyone who already has a row predates the
-- onboarding flow and shouldn't be sent through it on next sign-in.
-- New users created by the on_auth_user_created trigger from this point
-- on pick up the default (false) and route into onboarding as expected.
update public.profiles set onboarded = true;
