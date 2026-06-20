// Library status — the user's relationship to a single title. Owned
// here (not on the title-detail screen) so the inbox card badge and
// the title-screen YOUR marker stay phrased consistently. They MUST
// read as compact and full-sentence views of the same fact, or the
// user sees one wording on the inbox row and a different wording
// when they tap through.

import { formatRatingStars, type MediaType } from './rating';
import supabase from './supabase';

export type ItemStatus = 'watchlist' | 'watching' | 'watched';

// Per-item visibility — who can see the user's activity (status, rating)
// on a title. Mirrors items.visibility ('friends' default | 'private')
// from migration 20260607140000; 'private' hides the activity from
// friends but does NOT hide/remove the title from the user's own
// library. A future 'public' tier would extend the DB CHECK + this union.
export type ItemVisibility = 'friends' | 'private';

// Single write path for items.visibility, reused by every reachable
// privacy control (title page, library row, and — in shape — the review
// flow's "who can see this" toggle). A bare UPDATE keyed on the identity
// triple: items RLS already restricts this to the author's own row, so no
// guard beyond the explicit eq is needed. Caller supplies userId from the
// active session.
export async function setItemVisibility(args: {
    userId: string;
    tmdbId: number;
    mediaType: MediaType;
    visibility: ItemVisibility;
}): Promise<void> {
    const { userId, tmdbId, mediaType, visibility } = args;
    const { error } = await supabase
        .from('items')
        .update({ visibility })
        .eq('user_id', userId)
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType);
    if (error) throw error;
}

// Full-sentence form used on the title detail screen as the YOUR
// marker above the status pills — reads as a personal statement.
// Returns null when the user has no relationship to the title (no
// items row), so the caller can skip rendering the block entirely.
export function formatYourMarker(
    status: ItemStatus | null,
    rating: number | null,
): string | null {
    if (!status) return null;
    if (status === 'watchlist') return 'On your watchlist';
    if (status === 'watching') return "You're watching this";
    // status === 'watched'
    if (rating !== null) return `You rated this ${formatRatingStars(rating)}`;
    return "You've watched this";
}

// Compact badge form used on the inbox rec card — sits as a small
// pill next to the title sentence. Same fact as formatYourMarker,
// shorter wording so it fits inside a list row. Always returns a
// non-null string; the caller decides whether the user has a status
// at all (no zero state — render nothing in that case rather than
// show a placeholder).
export function formatLibraryBadge(
    status: ItemStatus,
    rating: number | null,
): string {
    if (status === 'watchlist') return 'Watchlist';
    if (status === 'watching') return 'Watching';
    // status === 'watched'
    if (rating !== null) return `Watched · ${formatRatingStars(rating)}`;
    return 'Watched';
}
