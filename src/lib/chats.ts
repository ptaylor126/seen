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
    // Episode scope (migration 20260713140000): both null = a whole-show chat
    // (today's behaviour), both set = a chat about a specific TV episode. The
    // DB constraint guarantees they're both-null or both-set.
    season: number | null;
    episode: number | null;
    createdAt: string;
}

// The chat row by id. null = not found OR not a party (RLS returns no row
// for non-parties / blocked pairs — indistinguishable by design).
export async function getTitleChat(
    chatId: string,
): Promise<TitleChatRow | null> {
    const { data, error } = await db
        .from('title_chats')
        .select(
            'id, from_user_id, to_user_id, tmdb_id, media_type, season, episode, created_at',
        )
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
        season: data.season ?? null,
        episode: data.episode ?? null,
        createdAt: data.created_at,
    };
}

// The existing chat between these two users about this title, if any —
// EITHER direction (the pair-unique is direction-agnostic). RLS scopes the
// lookup to chats the caller is party to, so matching on the other party +
// title is enough; both directions are filtered explicitly for clarity.
// null = no chat yet (or not visible — indistinguishable by design).
export async function findTitleChat(
    userId: string,
    otherUserId: string,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    // Episode scope. Omitted / null → the WHOLE-SHOW chat (season is null);
    // both set → the chat for that specific episode. These are distinct rows
    // under the two partial unique indexes, so the filter must be explicit or
    // an episode lookup would collide with the whole-show row.
    season: number | null = null,
    episode: number | null = null,
): Promise<string | null> {
    let query = db
        .from('title_chats')
        .select('id')
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType)
        .or(
            `and(from_user_id.eq.${userId},to_user_id.eq.${otherUserId}),` +
                `and(from_user_id.eq.${otherUserId},to_user_id.eq.${userId})`,
        );
    query =
        season !== null && episode !== null
            ? query.eq('season', season).eq('episode', episode)
            : query.is('season', null).is('episode', null);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
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
    // Episode scope. Omit for a whole-show chat; pass BOTH for an episode
    // chat. The DB enforces both-null-or-both-set; we normalise here so a
    // caller can't insert one without the other.
    season?: number | null;
    episode?: number | null;
}): Promise<string> {
    const { userId, otherUserId, tmdbId, mediaType, firstMessage } = args;
    // Both-or-neither: if either is missing, this is a whole-show chat.
    const episodeScoped =
        args.season !== null &&
        args.season !== undefined &&
        args.episode !== null &&
        args.episode !== undefined;
    const season = episodeScoped ? (args.season as number) : null;
    const episode = episodeScoped ? (args.episode as number) : null;

    let chatId: string;
    const { data: inserted, error: insertError } = await db
        .from('title_chats')
        .insert({
            from_user_id: userId,
            to_user_id: otherUserId,
            tmdb_id: tmdbId,
            media_type: mediaType,
            season,
            episode,
        })
        .select('id')
        .single();

    if (insertError) {
        if ((insertError as { code?: string }).code !== '23505') {
            throw insertError;
        }
        // Chat already exists (either direction) — open it instead. Scope the
        // lookup to the same episode (or the whole-show row) so we open the
        // right conversation, not a different-scope one for the same title.
        const existingId = await findTitleChat(
            userId,
            otherUserId,
            tmdbId,
            mediaType,
            season,
            episode,
        );
        if (!existingId) throw insertError; // conflict but not visible — bail
        chatId = existingId;
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
        season: number | null;
        episode: number | null;
        createdAt: string;
    }>
> {
    const { data, error } = await db
        .from('title_chats')
        .select('id, to_user_id, tmdb_id, media_type, season, episode, created_at')
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
                season: number | null;
                episode: number | null;
                created_at: string;
            }) => ({
                id: c.id,
                toUserId: c.to_user_id,
                tmdbId: c.tmdb_id,
                mediaType: c.media_type,
                season: c.season ?? null,
                episode: c.episode ?? null,
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
