import type { WatcherSheetItem } from '@/components/watchers-sheet';
import supabase from '@/lib/supabase';

// One watcher of one title. `recommendedToMe` = this friend has a non-
// dismissed recommendation of THIS title to the querying user (same rule as
// the watchlist_overlap trigger). It's a FLAG, not a filter: consumers decide
// whether to drop it ("who to talk to about this" prompts) or keep it ("who
// has seen this" lists). One query, one rule, computed once — no consumer
// re-derives the query.
export interface WatchedByTitleEntry {
    userId: string;
    rating: number | null;
    recommendedToMe: boolean;
}

// Batched core: for each tmdb_id, the friends who have it watched +
// friends-visible (most-recent-first, deduped), each flagged with
// recommendedToMe. Keyed by `${media_type}:${tmdb_id}` (a single-column
// .in() on tmdb_id pulls a superset across both media types; the key
// disambiguates). Privacy contract: status='watched' AND visibility='friends'
// (privately-watched friends appear nowhere); RLS scopes non-self rows to
// actual friends (blocking auto-unfriends), the explicit filter is defence in
// depth. The recommender flag comes from one recommendations-to-me query.
export async function getFriendsWhoWatchedByTitle(
    userId: string,
    tmdbIds: number[],
): Promise<Map<string, WatchedByTitleEntry[]>> {
    const result = new Map<string, WatchedByTitleEntry[]>();
    const unique = Array.from(new Set(tmdbIds));
    if (unique.length === 0) return result;

    const [watchRes, recRes] = await Promise.all([
        supabase
            .from('items')
            .select('user_id, tmdb_id, media_type, rating, updated_at')
            .in('tmdb_id', unique)
            .eq('status', 'watched')
            .eq('visibility', 'friends')
            .neq('user_id', userId)
            .order('updated_at', { ascending: false }),
        // Recommendations of these titles TO me (non-dismissed). RLS allows
        // this — I'm the recipient (recommendations_select_party). Keyed
        // media:tmdb:sender to flag the matching watcher per title.
        supabase
            .from('recommendations')
            .select('from_user_id, tmdb_id, media_type')
            .eq('to_user_id', userId)
            .in('tmdb_id', unique)
            .neq('status', 'dismissed'),
    ]);
    if (watchRes.error) throw watchRes.error;
    if (recRes.error) throw recRes.error;

    const recommendedSet = new Set<string>();
    for (const r of recRes.data ?? []) {
        if (!r.from_user_id) continue;
        recommendedSet.add(`${r.media_type}:${r.tmdb_id}:${r.from_user_id}`);
    }

    const seenPerKey = new Map<string, Set<string>>();
    for (const row of watchRes.data ?? []) {
        if (!row.user_id) continue;
        const key = `${row.media_type}:${row.tmdb_id}`;
        let seen = seenPerKey.get(key);
        if (!seen) {
            seen = new Set();
            seenPerKey.set(key, seen);
            result.set(key, []);
        }
        if (seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        result.get(key)!.push({
            userId: row.user_id,
            rating: typeof row.rating === 'number' ? row.rating : null,
            recommendedToMe: recommendedSet.has(
                `${row.media_type}:${row.tmdb_id}:${row.user_id}`,
            ),
        });
    }
    return result;
}

// "Friends who watched this title" — single-title wrapper over the batched
// core, resolving profiles into WatcherSheetItem rows (carrying the
// recommendedToMe flag through). Returns ALL watchers; consumers filter the
// flagged ones where the surface is a "who to talk to" prompt.
export async function getFriendsWhoWatched(
    userId: string,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<WatcherSheetItem[]> {
    const byKey = await getFriendsWhoWatchedByTitle(userId, [tmdbId]);
    const entries = byKey.get(`${mediaType}:${tmdbId}`) ?? [];
    if (entries.length === 0) return [];

    // Resolve profiles in one trip; preserve the entries' order — the DB
    // doesn't promise an order on .in(), so explicit mapping keeps the stack
    // deterministic (most-recent watcher first).
    const { data: profileRows, error: profileErr } = await supabase
        .from('profiles')
        .select('id, handle, display_name, avatar_url')
        .in(
            'id',
            entries.map((e) => e.userId),
        );
    if (profileErr) throw profileErr;
    const byId = new Map((profileRows ?? []).map((p) => [p.id, p]));
    const rows: WatcherSheetItem[] = [];
    for (const e of entries) {
        const p = byId.get(e.userId);
        if (!p) continue;
        rows.push({
            userId: p.id,
            handle: p.handle,
            displayName: p.display_name,
            avatarUrl: p.avatar_url,
            rating: e.rating,
            recommendedToMe: e.recommendedToMe,
        });
    }
    return rows;
}
