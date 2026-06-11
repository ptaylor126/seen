// Loader for a user's "top 5" lists (one ranked list of films, one of
// shows). Same batch-and-stitch pattern the library uses: one query
// against public.favorites, then fetchTitlesByItems for the titles
// metadata in one round-trip. No per-row TMDB or per-row titles
// lookups.
//
// RLS does the visibility check at the DB layer — the SELECT policy
// is owner OR is_friend_of_auth(user_id). Calling this with a non-
// friend's userId returns an empty array, not an error.

import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';

export interface FavoriteItem {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    rank: number;
    // Empty string when the titles catalogue doesn't have a row for
    // (tmdb_id, media_type) yet — matches the library's
    // "Unable-to-load" placeholder shape. Should be rare post-backfill
    // + forward-stamping; the renderer falls back gracefully either
    // way.
    title: string;
    posterPath: string | null;
}

export interface UserFavorites {
    movies: FavoriteItem[]; // Sorted by rank ASC, 1-5.
    tv: FavoriteItem[];     // Sorted by rank ASC, 1-5.
}

export async function fetchFavoritesForUser(
    userId: string,
): Promise<UserFavorites> {
    const { data: rows, error } = await supabase
        .from('favorites')
        .select('media_type, tmdb_id, rank')
        .eq('user_id', userId)
        .order('media_type', { ascending: true })
        .order('rank', { ascending: true });
    if (error) throw error;

    const titleByKey = await fetchTitlesByItems(rows ?? []);

    const movies: FavoriteItem[] = [];
    const tv: FavoriteItem[] = [];
    for (const r of rows ?? []) {
        if (r.media_type !== 'movie' && r.media_type !== 'tv') continue;
        const titleRow = titleByKey.get(`${r.media_type}:${r.tmdb_id}`);
        const item: FavoriteItem = {
            tmdbId: r.tmdb_id,
            mediaType: r.media_type,
            rank: r.rank,
            title: titleRow?.title ?? '',
            posterPath: titleRow?.poster_path ?? null,
        };
        if (r.media_type === 'movie') movies.push(item);
        else tv.push(item);
    }
    return { movies, tv };
}
