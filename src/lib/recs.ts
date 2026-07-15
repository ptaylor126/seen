import type { MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';

// One recommendation the current user received for a given title, with the
// sender's profile. Deduped to one entry per sender (their most-recent rec).
export interface ReceivedRec {
    recId: string;
    fromUserId: string;
    sentAt: string;
    note: string | null;
    // Season scope of this rec (null = whole show). Display-only — the card
    // shows "Season N" when set.
    season: number | null;
    sender: {
        handle: string;
        displayName: string;
        avatarUrl: string | null;
    };
}

// "Recs I received for this title" — every non-dismissed recommendation
// (pending | accepted | watched) addressed to `userId` for (tmdbId, mediaType),
// deduped to one entry per sender (their most-recent rec, keeping its note),
// joined to the sender profile. Throws on the recommendations query error;
// senders whose profile row didn't come back are dropped (defensive). Extracted
// from the title screen's "Recommended by" loader so it can be reused.
export async function getReceivedRecsForTitle(
    userId: string,
    tmdbId: number,
    mediaType: MediaType,
): Promise<ReceivedRec[]> {
    const { data: recRows, error } = await supabase
        .from('recommendations')
        .select('id, from_user_id, sent_at, note, season')
        .eq('to_user_id', userId)
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType)
        .in('status', ['pending', 'accepted', 'watched'])
        .order('sent_at', { ascending: false });
    if (error) throw error;
    if (!recRows || recRows.length === 0) return [];

    // Dedup by sender, most-recent-first (rows are already sent_at DESC),
    // keeping the rec id + sent_at + note from each sender's most-recent rec.
    // A sender can appear twice if they re-sent after a dismiss — rare, but
    // cheap to guard.
    const senderIds: string[] = [];
    const bySender = new Map<
        string,
        {
            recId: string;
            sentAt: string;
            note: string | null;
            season: number | null;
        }
    >();
    for (const row of recRows) {
        const sid = row.from_user_id;
        if (!sid || bySender.has(sid)) continue;
        senderIds.push(sid);
        const note =
            typeof row.note === 'string' && row.note.trim().length > 0
                ? row.note
                : null;
        bySender.set(sid, {
            recId: row.id,
            sentAt: row.sent_at,
            note,
            season: typeof row.season === 'number' ? row.season : null,
        });
    }
    if (senderIds.length === 0) return [];

    const { data: profileRows } = await supabase
        .from('profiles')
        .select('id, handle, display_name, avatar_url')
        .in('id', senderIds);
    const profileById = new Map((profileRows ?? []).map((p) => [p.id, p]));

    return senderIds
        .map((id): ReceivedRec | null => {
            const p = profileById.get(id);
            const meta = bySender.get(id);
            if (!p || !meta) return null;
            return {
                recId: meta.recId,
                fromUserId: id,
                sentAt: meta.sentAt,
                note: meta.note,
                season: meta.season,
                sender: {
                    handle: p.handle,
                    displayName: p.display_name,
                    avatarUrl: p.avatar_url,
                },
            };
        })
        .filter((r): r is ReceivedRec => r !== null);
}
