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

// The rating as star glyphs: '★' repeated floor(stars) times, plus '½' for a
// half. rating is the 1-10 half-scale (2 = 1★, 9 = 4½★), so full = floor(r/2)
// and a half when r is odd. e.g. 8 → "★★★★", 9 → "★★★★½", 1 → "½". The app's
// glyph-star language — watched comments and the watcher-picker both use it.
export function ratingGlyphs(rating: number): string {
    return '★'.repeat(Math.floor(rating / 2)) + (rating % 2 === 1 ? '½' : '');
}

// Apply a 1-10 star rating (or skip with `null`) to a watched title.
// Updates items.rating when a value was chosen, and transitions each matching
// open recommendation (pending | accepted) into `watched` via the
// mark_recommendation_watched RPC — one call per rec, so each carries its own
// transaction-local suppress flag. Suppressing a rec (its sender is in
// `suppressRecIds` because they're getting a comment instead) skips the
// rec_watched notification, giving one notification per action. The RPC also
// suppresses when the item is private (checked server-side). The rec's
// rating_thumb (credibility signal) is set from the star value when rating is
// given, via the RPC's p_thumb arg (coalesced, so a skip leaves it unchanged).
export async function applyWatchedRating(args: {
    userId: string;
    tmdbId: number;
    mediaType: MediaType;
    rating: number | null;
    // Rec ids whose sender should NOT get a rec_watched notification (they're
    // receiving a comment from the post-watched sheet instead).
    suppressRecIds?: ReadonlySet<string>;
}): Promise<void> {
    const { userId, tmdbId, mediaType, rating, suppressRecIds } = args;

    if (rating !== null) {
        const { error: itemError } = await supabase
            .from('items')
            .update({ rating })
            .eq('user_id', userId)
            .eq('tmdb_id', tmdbId)
            .eq('media_type', mediaType);
        if (itemError) throw itemError;
    }

    // Matches open recs by (recipient, title) ONLY — deliberately
    // SEASON-BLIND. Recs can carry a season coordinate (S1, S4…), and a title
    // can have several open at once, but watched-tracking is title-level and
    // high-water-mark: marking the TITLE watched means you watched the show,
    // so ALL its open recs resolve together here. Do NOT add `.eq('season',…)`
    // — per-season resolution would require season-level watched state, which
    // we deliberately do not build. (Same intent recorded in migration
    // 20260714150000's header, which also covers the season-blind
    // reopen_recs_on_unwatch trigger.)
    const { data: openRecs, error: queryError } = await supabase
        .from('recommendations')
        .select('id')
        .eq('to_user_id', userId)
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType)
        .in('status', ['pending', 'accepted']);
    if (queryError) throw queryError;

    const thumb: RatingThumb | null =
        rating !== null ? thumbFromRating(rating) : null;

    for (const rec of openRecs ?? []) {
        // reason: mark_recommendation_watched isn't in the generated Supabase
        // types yet (created live in the dashboard, types not regenerated); cast
        // supabase.rpc to its known signature. It MUST stay a direct
        // `supabase.rpc(...)` member call (a parenthesized cast, not extracted
        // into a variable) so `this` binds to the client — otherwise rpc reads
        // `this.rest` off undefined and throws.
        const { error: rpcError } = await (
            supabase.rpc as unknown as (
                fn: string,
                args: {
                    p_rec_id: string;
                    p_suppress: boolean;
                    p_thumb: RatingThumb | null;
                },
            ) => Promise<{ error: { message: string } | null }>
        )('mark_recommendation_watched', {
            p_rec_id: rec.id,
            p_suppress: suppressRecIds?.has(rec.id) ?? false,
            p_thumb: thumb,
        });
        if (rpcError) throw rpcError;
    }
}
