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
// SELECT-then-UPDATE-or-INSERT rather than UPSERT: the
// `favorites_user_media_rank_unique` constraint became DEFERRABLE
// INITIALLY DEFERRED in 20260615130000 (required for reorder_favorites
// to do its atomic multi-row renumber via a single UPDATE without
// per-row UNIQUE collision), and DEFERRABLE unique constraints
// cannot be used as ON CONFLICT arbiters per PG docs. So the old
// .upsert({ onConflict: 'user_id,media_type,rank' }) shape would now
// throw 42P10. Two round-trips instead of one; the race window
// between SELECT and INSERT/UPDATE is unobservable in practice
// (this is the editor on a single user's own device, no concurrent
// writers).
//
// Caller MUST pre-check that this tmdb_id isn't already at a DIFFERENT
// rank for this user in this category — the OTHER UNIQUE constraint
// `favorites_user_media_tmdb_unique` (user_id, media_type, tmdb_id)
// stays non-deferrable and would fire on the INSERT/UPDATE otherwise.
// The editor screen surfaces "Already in your top 5 at rank N" before
// this is called.
export async function addFavoriteAtRank(args: {
    userId: string;
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    rank: number;
}): Promise<void> {
    // Is this rank slot already occupied? If yes, this is a
    // replace-at-rank flow (full category → user picked which slot to
    // overwrite); if no, fresh add to an open slot.
    const { data: existing, error: lookupErr } = await supabase
        .from('favorites')
        .select('id')
        .eq('user_id', args.userId)
        .eq('media_type', args.mediaType)
        .eq('rank', args.rank)
        .maybeSingle();
    if (lookupErr) throw lookupErr;

    if (existing) {
        // Replace-at-rank: only tmdb_id changes; id and created_at
        // stay (the slot keeps its identity, just points at a new
        // title). RLS update policy gates on user_id = auth.uid()
        // so a foreign id couldn't be hit even by accident.
        const { error } = await supabase
            .from('favorites')
            .update({ tmdb_id: args.tmdbId })
            .eq('id', existing.id);
        if (error) throw error;
    } else {
        // Fresh add to an open rank slot.
        const { error } = await supabase.from('favorites').insert({
            user_id: args.userId,
            media_type: args.mediaType,
            tmdb_id: args.tmdbId,
            rank: args.rank,
        });
        if (error) throw error;
    }
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

// Atomically renumber a user's favorites in one category. Calls the
// reorder_favorites RPC (security-definer, single-statement UPDATE
// via unnest WITH ORDINALITY) — see migration
// 20260615120000_create_reorder_favorites_rpc.sql for the why.
//
// Caller MUST pass the FULL list of ids for the category in their
// new desired order; the RPC rejects partial reorders (which would
// otherwise trip the rank UNIQUE constraint by leaving orphan ranks
// that collide with the renumbered slots). Used by three call sites:
//   - drag-to-reorder on drop (full new ordering)
//   - auto-renormalize after remove (remaining ids in current order)
//   - opportunistic compaction on editor load when a gap is detected
export async function reorderFavorites(args: {
    mediaType: 'movie' | 'tv';
    orderedIds: string[];
}): Promise<void> {
    if (args.orderedIds.length === 0) return; // matches RPC no-op
    const { error } = await supabase.rpc('reorder_favorites', {
        p_media_type: args.mediaType,
        p_ordered_ids: args.orderedIds,
    });
    if (error) throw error;
}
