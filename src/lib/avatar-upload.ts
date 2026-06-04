// Profile avatar upload pipeline.
//
//   1. Library picker (square-cropped natively).
//   2. Resize to 256x256 + JPEG re-encode (handles HEIC, oversized
//      originals, and odd aspect ratios uniformly).
//   3. ArrayBuffer upload to Supabase Storage (RN-safe — Blob upload
//      has long-standing zero-byte bugs on iOS in some configurations).
//   4. profiles.avatar_url updated to the new public URL.
//   5. Best-effort delete of the previous storage object (fire-and-
//      forget; orphans are acceptable for v1).
//
// The pipeline is library-picker only — camera capture skipped for v1
// per scope decisions. Adding it later means another permission flow and
// a tiny launchCameraAsync wrapper; the rest of this file stays.

import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import supabase from './supabase';

const BUCKET = 'avatars';
const TARGET_SIZE = 256; // px; covers 3× density at the largest display (80pt → 240px)
const JPEG_QUALITY = 0.85;
const SIZE_LIMIT_BYTES = 524288; // matches the bucket's file_size_limit (512 KB)

export type AvatarUploadResult =
    | { kind: 'uploaded'; publicUrl: string }
    | { kind: 'cancelled' }
    | { kind: 'permission_denied' }
    | { kind: 'failed'; message: string };

interface UploadArgs {
    userId: string;
    /** Current avatar_url from profiles. When set AND points at our own
     *  avatars bucket, the corresponding object is deleted after the
     *  new one is uploaded. External URLs (e.g. legacy values) are
     *  left alone. */
    previousAvatarUrl: string | null;
}

export async function pickAndUploadAvatar(
    args: UploadArgs,
): Promise<AvatarUploadResult> {
    const { userId, previousAvatarUrl } = args;

    // Permission check first so we can short-circuit if the user has
    // denied photos access without launching the picker (which would
    // also throw but with a less actionable error).
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
        return { kind: 'permission_denied' };
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // allowsEditing + aspect [1,1] gives the native square cropper
        // on iOS and Android. Without aspect the user could pick a
        // rectangular crop which would then get re-distorted by the
        // resize step.
        allowsEditing: true,
        aspect: [1, 1],
        // quality: 1 maximizes the fidelity going INTO the manipulator,
        // which is where the actual compression decision is made.
        quality: 1,
    });
    if (picked.canceled || !picked.assets[0]) {
        return { kind: 'cancelled' };
    }

    try {
        const manipulated = await ImageManipulator.manipulateAsync(
            picked.assets[0].uri,
            [{ resize: { width: TARGET_SIZE, height: TARGET_SIZE } }],
            {
                compress: JPEG_QUALITY,
                format: ImageManipulator.SaveFormat.JPEG,
            },
        );

        // RN file URI → ArrayBuffer via fetch. The fetch source is a
        // local file, so the cost is just disk read + decode — no
        // network hop. ArrayBuffer is the supabase-js Storage shape
        // that uploads cleanly on both iOS and Android.
        const response = await fetch(manipulated.uri);
        const arrayBuffer = await response.arrayBuffer();

        // Defensive guard against the bucket's 512 KB limit. The
        // pipeline should never produce a file this large at 256x256
        // JPEG q=0.85, but we'd rather catch a runaway encoder here
        // with an actionable message than surface a Postgres-style
        // bucket-rejection error to the user.
        if (arrayBuffer.byteLength > SIZE_LIMIT_BYTES) {
            return {
                kind: 'failed',
                message: 'Image too large after compression — try a different photo.',
            };
        }

        const filename = `avatar-${Date.now()}.jpg`;
        const path = `${userId}/${filename}`;
        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(path, arrayBuffer, {
                contentType: 'image/jpeg',
                // 1 hour CDN cache. Each upload produces a new URL
                // (timestamped filename) so cache-control here only
                // affects intra-session re-fetches of the same URL —
                // expo-image still caches by URL on the device.
                cacheControl: '3600',
            });
        if (uploadError) {
            return {
                kind: 'failed',
                message: `Upload failed: ${uploadError.message}`,
            };
        }

        const { data: publicUrlData } = supabase.storage
            .from(BUCKET)
            .getPublicUrl(path);
        const publicUrl = publicUrlData.publicUrl;

        const { error: profileError } = await supabase
            .from('profiles')
            .update({ avatar_url: publicUrl })
            .eq('id', userId);
        if (profileError) {
            // Upload succeeded but DB update failed — orphan file in
            // storage. Report the DB error; the orphan can be reaped
            // later. Don't attempt rollback (deleting the just-uploaded
            // file) because if THAT also fails we leave the user with
            // no avatar AND an orphan.
            return {
                kind: 'failed',
                message: `Saved photo but couldn't update profile: ${profileError.message}`,
            };
        }

        // Best-effort cleanup of the previous avatar object. Only
        // attempt if the previous URL looks like one of ours (in the
        // avatars bucket); skip legacy or external URLs.
        const previousPath = parseAvatarsPath(previousAvatarUrl);
        if (previousPath && previousPath !== path) {
            void supabase.storage
                .from(BUCKET)
                .remove([previousPath])
                .then(({ error }) => {
                    if (error) {
                        console.warn('avatar cleanup failed:', error.message);
                    }
                });
        }

        return { kind: 'uploaded', publicUrl };
    } catch (err) {
        return {
            kind: 'failed',
            message: err instanceof Error ? err.message : 'Unknown error',
        };
    }
}

export async function removeAvatar(args: {
    userId: string;
    previousAvatarUrl: string | null;
}): Promise<{ kind: 'removed' } | { kind: 'failed'; message: string }> {
    const { userId, previousAvatarUrl } = args;

    const { error: profileError } = await supabase
        .from('profiles')
        .update({ avatar_url: null })
        .eq('id', userId);
    if (profileError) {
        return {
            kind: 'failed',
            message: `Couldn't update profile: ${profileError.message}`,
        };
    }

    // DB cleared — drop the storage object too if it was ours. Same
    // best-effort semantics as the upload cleanup: orphans are
    // acceptable, the visible state (DB) is now correct.
    const previousPath = parseAvatarsPath(previousAvatarUrl);
    if (previousPath) {
        void supabase.storage
            .from(BUCKET)
            .remove([previousPath])
            .then(({ error }) => {
                if (error) {
                    console.warn(
                        'avatar removal — storage delete failed:',
                        error.message,
                    );
                }
            });
    }

    return { kind: 'removed' };
}

// Parse the `{userId}/avatar-{ts}.jpg` path out of a public URL pointing
// at our avatars bucket. Returns null for any URL that doesn't look like
// one we produced — legacy external URLs are left untouched. Doing this
// by string match (rather than a Storage list lookup) keeps the cleanup
// fire-and-forget and free of extra round-trips.
function parseAvatarsPath(url: string | null): string | null {
    if (!url) return null;
    const marker = `/storage/v1/object/public/${BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    return url.slice(idx + marker.length);
}
