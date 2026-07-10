import type { WatcherSheetItem } from '@/components/watchers-sheet';
import supabase from '@/lib/supabase';

// "Friends who watched this title" — extracted verbatim from the title
// page's friend-activity block so the overlap banner and watcher-picker can
// reuse it. Privacy contract: only rows with status='watched' AND
// visibility='friends' (privately-watched friends appear nowhere); RLS
// scopes non-self rows to actual friends (and blocking auto-unfriends), the
// explicit filter is defence in depth. Most-recent watcher first.
export async function getFriendsWhoWatched(
    userId: string,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<WatcherSheetItem[]> {
    const { data: friendRows, error: friendErr } = await supabase
        .from('items')
        .select('user_id, rating, updated_at')
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType)
        .eq('status', 'watched')
        .eq('visibility', 'friends')
        .neq('user_id', userId)
        .order('updated_at', { ascending: false });
    if (friendErr) throw friendErr;

    // Dedupe by user (one items row per user/title by constraint, but guard
    // anyway), preserving the most-recent-first order. Keep each user's
    // rating for the sheet rows.
    const watchedIds: string[] = [];
    const seen = new Set<string>();
    const ratingByUser = new Map<string, number | null>();
    for (const row of friendRows ?? []) {
        if (!row.user_id || seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        watchedIds.push(row.user_id);
        ratingByUser.set(
            row.user_id,
            typeof row.rating === 'number' ? row.rating : null,
        );
    }
    if (watchedIds.length === 0) return [];

    // Resolve profiles in one trip; preserve watchedIds order — the DB
    // doesn't promise an order on .in(), so explicit mapping keeps the
    // stack deterministic.
    const { data: profileRows, error: profileErr } = await supabase
        .from('profiles')
        .select('id, handle, display_name, avatar_url')
        .in('id', watchedIds);
    if (profileErr) throw profileErr;
    const byId = new Map((profileRows ?? []).map((p) => [p.id, p]));
    return watchedIds
        .map((id) => byId.get(id))
        .filter(
            (
                p,
            ): p is {
                id: string;
                handle: string;
                display_name: string;
                avatar_url: string | null;
            } => !!p,
        )
        .map((p) => ({
            userId: p.id,
            handle: p.handle,
            displayName: p.display_name,
            avatarUrl: p.avatar_url,
            rating: ratingByUser.get(p.id) ?? null,
        }));
}
