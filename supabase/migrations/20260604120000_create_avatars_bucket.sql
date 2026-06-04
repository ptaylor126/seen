-- Avatars storage bucket — public-read, owner-only-write.
--
-- See PRD/TECHNICAL: user profile pictures are shown to friends across
-- the app surface (Recs hero, friends list, watcher stacks, library
-- attribution chips, inbox rows, etc.). Public-read is appropriate
-- because: (a) avatars are by their nature meant to be seen — uploading
-- one IS the consent to display, (b) signed URLs would break expo-image's
-- URL-based cache on every render and add per-fetch latency, and (c) any
-- write is gated by RLS to the owner's user-id-prefixed folder.
--
-- Object path convention: `{auth.uid()}/avatar-{ms-timestamp}.jpg`.
-- The folder-prefix gives a simple `(storage.foldername(name))[1] =
-- auth.uid()::text` policy condition for all writes. The timestamped
-- filename means each upload produces a new URL so expo-image's cache
-- picks up the new image cleanly; the old object is removed client-side
-- (best-effort) after the new one is saved.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'avatars',
    'avatars',
    true,
    -- 512 KB hard cap. A 256x256 JPEG at quality 0.85 is typically
    -- 30-80 KB; this leaves comfortable headroom for higher-density
    -- variants if we ever raise the resize target, while keeping a
    -- ceiling that blocks pathological uploads.
    524288,
    array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Public read — anyone can fetch any avatar URL. Enforced both by the
-- bucket-level `public = true` above and by an explicit SELECT policy
-- so a future bucket reconfiguration can't accidentally lock reads.
create policy "avatars_select_public"
    on storage.objects
    for select
    using (bucket_id = 'avatars');

-- Owner-only-write. The user's auth.uid() must be the first folder
-- segment in the object's path. storage.foldername(name) is the
-- canonical Supabase helper for this pattern; it returns the array of
-- folder names from the path and we check the first one.
create policy "avatars_insert_own_folder"
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

create policy "avatars_update_own_folder"
    on storage.objects
    for update
    to authenticated
    using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

create policy "avatars_delete_own_folder"
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
