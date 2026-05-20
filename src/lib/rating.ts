import supabase from '@/lib/supabase';

export type MediaType = 'movie' | 'tv';
export type RatingThumb = 'up' | 'down';

// items.rating stores the 1-5 value directly. The recommendations table
// still carries a coarser rating_thumb (up | down) as the credibility
// signal between friends — derived from the star value: 1-2 = down,
// 3-5 = up.
export function thumbFromRating(rating: number): RatingThumb {
    return rating <= 2 ? 'down' : 'up';
}

// Apply a 1-5 star rating (or skip with `null`) to a watched title.
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
