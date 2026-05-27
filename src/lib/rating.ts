import supabase from '@/lib/supabase';

export type MediaType = 'movie' | 'tv';
export type RatingThumb = 'up' | 'down';

// items.rating stores a 1-10 half-star value (odd = half, even = whole;
// so 1 = ½★, 2 = 1★, …, 9 = 4½★, 10 = 5★). The recommendations table
// still carries a coarser rating_thumb (up | down) as the credibility
// signal between friends — derived from the stored value: 1-4 = down
// (≤ 2★), 5-10 = up (≥ 2½★).
export function thumbFromRating(rating: number): RatingThumb {
    return rating <= 4 ? 'down' : 'up';
}

// Format a 1-10 stored rating as a human-readable star count: 8 → "4★",
// 9 → "4.5★", 1 → "0.5★". JS division produces the correct decimal
// (rating=9 / 2 = 4.5) so no explicit half-star handling needed.
export function formatRatingStars(rating: number): string {
    return `${rating / 2}★`;
}

// Apply a 1-10 star rating (or skip with `null`) to a watched title.
// Updates items.rating when a value was chosen, and always transitions
// any matching open recommendations (pending | accepted) into `watched`
// — which fires the rec_watched notification trigger for the sender.
// rating_thumb on the rec is derived from the star value only when the
// user chose a rating; skipping leaves it null.
export async function applyWatchedRating(args: {
    userId: string;
    tmdbId: number;
    mediaType: MediaType;
    rating: number | null;
}): Promise<void> {
    const { userId, tmdbId, mediaType, rating } = args;

    if (rating !== null) {
        const { error: itemError } = await supabase
            .from('items')
            .update({ rating })
            .eq('user_id', userId)
            .eq('tmdb_id', tmdbId)
            .eq('media_type', mediaType);
        if (itemError) throw itemError;
    }

    const { data: openRecs, error: queryError } = await supabase
        .from('recommendations')
        .select('id')
        .eq('to_user_id', userId)
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType)
        .in('status', ['pending', 'accepted']);
    if (queryError) throw queryError;

    if (openRecs && openRecs.length > 0) {
        const update: {
            status: 'watched';
            watched_via_rec: boolean;
            rating_thumb?: RatingThumb;
        } = {
            status: 'watched',
            watched_via_rec: true,
        };
        if (rating !== null) update.rating_thumb = thumbFromRating(rating);

        const { error: recError } = await supabase
            .from('recommendations')
            .update(update)
            .in(
                'id',
                openRecs.map((r) => r.id),
            );
        if (recError) throw recError;
    }
}
