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
    // The favorites row id — needed by the editor's remove flow to
    // DELETE the specific row. Layer 2 (display-only) doesn't read it,
    // so callers can still ignore it; layer 3 (editor) requires it.
    id: string;
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
        .select('id, media_type, tmdb_id, rank')
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
            id: r.id,
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

// Insert (or replace-at-rank) a favorites row for the current user.
// UPSERT with onConflict on (user_id, media_type, rank): a fresh add
// inserts; a "replace at occupied rank" updates the existing row's
// tmdb_id in place — single round-trip, no DELETE-then-INSERT race
// window. The composite-key target is the `favorites_user_media_rank_unique`
// constraint defined in 20260610120000_create_favorites_table.sql.
// PostgREST translates `on_conflict=user_id,media_type,rank` into PG's
// ON CONFLICT (col_list) form — column-list parsing only (no plpgsql
// substitution, distinct from the ensure_title #variable_conflict
// issue), so the column tuple matches the constraint directly.
//
// Caller MUST pre-check that this tmdb_id isn't already at a DIFFERENT
// rank for this user in this category — the other UNIQUE constraint
// `favorites_user_media_tmdb_unique` (user_id, media_type, tmdb_id)
// would fire otherwise. The editor screen surfaces "Already in your
// top 5" before this is called.
export async function addFavoriteAtRank(args: {
    userId: string;
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    rank: number;
}): Promise<void> {
    const { error } = await supabase.from('favorites').upsert(
        {
            user_id: args.userId,
            media_type: args.mediaType,
            tmdb_id: args.tmdbId,
            rank: args.rank,
        },
        { onConflict: 'user_id,media_type,rank' },
    );
    if (error) throw error;
}

// Remove a single favorites row by id. NO change to items / library —
// un-favoriting doesn't un-watch. Caller is responsible for confirming
// with the user first.
export async function removeFavorite(favoriteId: string): Promise<void> {
    const { error } = await supabase
        .from('favorites')
        .delete()
        .eq('id', favoriteId);
    if (error) throw error;
}
