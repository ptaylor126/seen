import type { SupabaseClient } from '@supabase/supabase-js';

import supabase from '@/lib/supabase';

// "Chat about a title" data access (title_chats + chat_comments +
// chat_reactions + chat_comment_reactions — migration 20260709180000).
//
// reason: the chat tables aren't in the generated Database types yet (created
// live in the dashboard 2026-07-10, types not regenerated), so the typed
// client rejects their table names. Cast the client to the untyped generic
// ONCE here — every chat query goes through this module, so the cast doesn't
// spread. The cast keeps member calls on the same client object, so `this`
// binding is preserved (the supabase.rpc lesson).
const db = supabase as unknown as SupabaseClient;

export interface TitleChatRow {
    id: string;
    fromUserId: string;
    toUserId: string;
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    createdAt: string;
}

// The chat row by id. null = not found OR not a party (RLS returns no row
// for non-parties / blocked pairs — indistinguishable by design).
export async function getTitleChat(
    chatId: string,
): Promise<TitleChatRow | null> {
    const { data, error } = await db
        .from('title_chats')
        .select('id, from_user_id, to_user_id, tmdb_id, media_type, created_at')
        .eq('id', chatId)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const mediaType =
        data.media_type === 'movie' || data.media_type === 'tv'
            ? data.media_type
            : null;
    if (!mediaType) return null;
    return {
        id: data.id,
        fromUserId: data.from_user_id,
        toUserId: data.to_user_id,
        tmdbId: data.tmdb_id,
        mediaType,
        createdAt: data.created_at,
    };
}

// Insert a comment on a chat and return the DB-assigned id + created_at (so
// callers can optimistically append without a refetch). Clone of
// postRecComment minus fromWatched — chats have no watched-sheet semantics.
export async function postChatComment(
    chatId: string,
    userId: string,
    body: string,
): Promise<{ id: string; created_at: string }> {
    const { data, error } = await db
        .from('chat_comments')
        .insert({
            chat_id: chatId,
            user_id: userId,
            body,
        })
        .select('id, created_at')
        .single();
    if (error) throw error;
    return data;
}

// Start a chat with a friend about a title, posting `firstMessage` as its
// first comment. The pair-unique on title_chats is DIRECTION-AGNOSTIC (one
// chat per unordered pair per title), so a 23505 means the conversation
// already exists — in either direction; fetch it and post the message there
// instead. Both paths return the chatId to navigate to; the caller never
// sees the difference.
export async function createTitleChat(args: {
    userId: string;
    otherUserId: string;
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    firstMessage: string;
}): Promise<string> {
    const { userId, otherUserId, tmdbId, mediaType, firstMessage } = args;

    let chatId: string;
    const { data: inserted, error: insertError } = await db
        .from('title_chats')
        .insert({
            from_user_id: userId,
            to_user_id: otherUserId,
            tmdb_id: tmdbId,
            media_type: mediaType,
        })
        .select('id')
        .single();

    if (insertError) {
        if ((insertError as { code?: string }).code !== '23505') {
            throw insertError;
        }
        // Chat already exists (either direction). RLS scopes the lookup to
        // chats we're party to, so matching on the other party + title is
        // enough — but filter both directions explicitly for clarity.
        const { data: existing, error: lookupError } = await db
            .from('title_chats')
            .select('id')
            .eq('tmdb_id', tmdbId)
            .eq('media_type', mediaType)
            .or(
                `and(from_user_id.eq.${userId},to_user_id.eq.${otherUserId}),` +
                    `and(from_user_id.eq.${otherUserId},to_user_id.eq.${userId})`,
            )
            .maybeSingle();
        if (lookupError) throw lookupError;
        if (!existing) throw insertError; // conflict but not visible — bail
        chatId = existing.id;
    } else {
        chatId = inserted.id;
    }

    await postChatComment(chatId, userId, firstMessage);
    return chatId;
}

// Chats the user STARTED (from_user_id = me), newest first — the inbox's
// Sent tab merges these alongside sent recs.
export async function getSentChats(
    userId: string,
    limit: number,
): Promise<
    Array<{
        id: string;
        toUserId: string;
        tmdbId: number;
        mediaType: 'movie' | 'tv';
        createdAt: string;
    }>
> {
    const { data, error } = await db
        .from('title_chats')
        .select('id, to_user_id, tmdb_id, media_type, created_at')
        .eq('from_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return (data ?? [])
        .filter(
            (c: { media_type: string }) =>
                c.media_type === 'movie' || c.media_type === 'tv',
        )
        .map(
            (c: {
                id: string;
                to_user_id: string;
                tmdb_id: number;
                media_type: 'movie' | 'tv';
                created_at: string;
            }) => ({
                id: c.id,
                toUserId: c.to_user_id,
                tmdbId: c.tmdb_id,
                mediaType: c.media_type,
                createdAt: c.created_at,
            }),
        );
}

export async function deleteChatComment(commentId: string): Promise<void> {
    const { error } = await db
        .from('chat_comments')
        .delete()
        .eq('id', commentId);
    if (error) throw error;
}

// Raw comment rows, chronological. The screen resolves authors + maps to the
// thread CommentRow shape (fromWatched: false — no watched semantics here).
export async function getChatComments(chatId: string): Promise<
    Array<{
        id: string;
        userId: string | null;
        body: string;
        createdAt: string;
    }>
> {
    const { data, error } = await db
        .from('chat_comments')
        .select('id, user_id, body, created_at')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(
        (c: {
            id: string;
            user_id: string | null;
            body: string;
            created_at: string;
        }) => ({
            id: c.id,
            userId: c.user_id,
            body: c.body,
            createdAt: c.created_at,
        }),
    );
}

// NB: no chat-LEVEL reaction helpers — chats carry message-level reactions
// only (chat_comment_reactions below). The chat_reactions table exists and
// stays in the realtime publication, but nothing client-side reads or writes
// it since the chat-level picker was removed (2026-07-10).

// Reactions on the given comments, for the per-comment chips.
export async function getChatCommentReactions(
    commentIds: string[],
): Promise<Array<{ commentId: string; userId: string; emoji: string }>> {
    if (commentIds.length === 0) return [];
    const { data, error } = await db
        .from('chat_comment_reactions')
        .select('comment_id, user_id, emoji')
        .in('comment_id', commentIds);
    if (error) throw error;
    return (data ?? []).map(
        (r: { comment_id: string; user_id: string; emoji: string }) => ({
            commentId: r.comment_id,
            userId: r.user_id,
            emoji: r.emoji,
        }),
    );
}

export async function setChatCommentReaction(
    chatId: string,
    commentId: string,
    userId: string,
    emoji: string,
): Promise<void> {
    const { error } = await db.from('chat_comment_reactions').upsert(
        {
            comment_id: commentId,
            user_id: userId,
            emoji,
            // Denormalized thread id (20260710150000) — gives the realtime
            // subscription a filterable column.
            chat_id: chatId,
        },
        { onConflict: 'comment_id,user_id' },
    );
    if (error) throw error;
}

export async function clearChatCommentReaction(
    commentId: string,
    userId: string,
): Promise<void> {
    const { error } = await db
        .from('chat_comment_reactions')
        .delete()
        .eq('comment_id', commentId)
        .eq('user_id', userId);
    if (error) throw error;
}
