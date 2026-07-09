import supabase from '@/lib/supabase';

// Insert a comment on a recommendation and return the DB-assigned id +
// created_at (so callers can optimistically append the new row without a
// refetch). Throws on error — the caller owns all UI concerns (optimistic
// append, busy flag, scroll, rollback). Extracted from rec/[recId].tsx's
// handlePostComment so the same write can be reused off the rec screen.
export async function postRecComment(
    recId: string,
    userId: string,
    body: string,
    // True when the comment originated from the post-watched sheet (carries the
    // rating line). The rec thread shows a quiet "watched" status for these.
    // Typed thread comments leave it default false.
    fromWatched = false,
): Promise<{ id: string; created_at: string }> {
    const { data, error } = await supabase
        .from('recommendation_comments')
        // reason: from_watched isn't in the generated Supabase types yet (added
        // live in the dashboard, types not regenerated) — cast the insert row,
        // same pattern as items.note.
        .insert({
            recommendation_id: recId,
            user_id: userId,
            body,
            from_watched: fromWatched,
        } as never)
        .select('id, created_at')
        .single();
    if (error) throw error;
    return data;
}
