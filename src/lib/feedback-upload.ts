// Feedback screenshot pipeline — a lighter sibling of avatar-upload.ts.
//
// Two steps so the screen can show a thumbnail before committing:
//   1. pickFeedbackImage(): library picker (no crop — a screenshot is
//      whole) → resize so the longest edge is <= MAX_EDGE (downscale
//      only, never upscale) + JPEG re-encode. Returns a LOCAL uri for
//      the thumbnail; nothing is uploaded yet.
//   2. uploadFeedbackScreenshot(): called at submit time — reads the
//      local file and uploads it to the private 'feedback' bucket under
//      <userId>/<uuid>.jpg, returning the storage PATH (the bucket is
//      private, so the path — not a public URL — is what the edge
//      function signs).
//
// Less aggressive than avatars (1600px longest edge vs 256px square) so
// screenshots stay readable.

import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import supabase from './supabase';

const BUCKET = 'feedback';
const MAX_EDGE = 1600; // px; longest-edge cap — keeps screenshots legible
const JPEG_QUALITY = 0.8;

export type FeedbackPickResult =
    | { kind: 'picked'; uri: string }
    | { kind: 'cancelled' }
    | { kind: 'permission_denied' }
    | { kind: 'failed'; message: string };

export async function pickFeedbackImage(): Promise<FeedbackPickResult> {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
        return { kind: 'permission_denied' };
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // No allowsEditing/aspect — a screenshot should be attached
        // whole, not square-cropped.
        allowsEditing: false,
        quality: 1,
    });
    if (picked.canceled || !picked.assets[0]) {
        return { kind: 'cancelled' };
    }

    const asset = picked.assets[0];
    try {
        // Downscale so the longest edge is <= MAX_EDGE, preserving aspect
        // by resizing only one dimension. Skip the resize entirely when
        // the image is already within the cap (no upscaling). An empty
        // actions array still re-encodes to JPEG (handles HEIC / PNG).
        const w = asset.width ?? 0;
        const h = asset.height ?? 0;
        const actions: { resize: { width?: number; height?: number } }[] = [];
        if (w > 0 && h > 0 && Math.max(w, h) > MAX_EDGE) {
            actions.push({
                resize: w >= h ? { width: MAX_EDGE } : { height: MAX_EDGE },
            });
        }

        const manipulated = await ImageManipulator.manipulateAsync(
            asset.uri,
            actions,
            {
                compress: JPEG_QUALITY,
                format: ImageManipulator.SaveFormat.JPEG,
            },
        );
        return { kind: 'picked', uri: manipulated.uri };
    } catch (err) {
        return {
            kind: 'failed',
            message: err instanceof Error ? err.message : 'Unknown error',
        };
    }
}

// Uploads the prepared local image to the private feedback bucket and
// returns the storage path (e.g. "<userId>/<uuid>.jpg"). Throws on
// failure so the caller's submit try/catch surfaces it inline.
export async function uploadFeedbackScreenshot(args: {
    userId: string;
    localUri: string;
}): Promise<string> {
    const { userId, localUri } = args;

    // RN file URI → ArrayBuffer via fetch (local disk read, no network).
    // ArrayBuffer is the Storage upload shape that's reliable on both
    // iOS and Android — same reason avatar-upload uses it.
    const response = await fetch(localUri);
    const arrayBuffer = await response.arrayBuffer();

    const path = `${userId}/${uuidv4()}.jpg`;
    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, arrayBuffer, {
            contentType: 'image/jpeg',
            cacheControl: '3600',
        });
    if (error) {
        throw new Error(`Screenshot upload failed: ${error.message}`);
    }
    return path;
}

// Lightweight v4-shaped UUID for a storage filename. Not security-
// sensitive — it only needs to be unique within the per-user folder —
// so this avoids adding expo-crypto as a dependency.
function uuidv4(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
