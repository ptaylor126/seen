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
): Promise<{ id: string; created_at: string }> {
    const { data, error } = await supabase
        .from('recommendation_comments')
        .insert({
            recommendation_id: recId,
            user_id: userId,
            body,
        })
        .select('id, created_at')
        .single();
    if (error) throw error;
    return data;
}
