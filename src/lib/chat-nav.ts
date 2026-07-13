import { router } from 'expo-router';

import { createTitleChat, findTitleChat } from '@/lib/chats';
import supabase from '@/lib/supabase';

// Single entry point for "chat with this friend about this title" — the
// overlap flows (banner tap → watcher pick, inbox overlap row → watcher
// pick) all land here. Opens the EXISTING chat if one exists in either
// direction (the pair-unique is direction-agnostic), otherwise pushes the
// compose screen with the friend pre-selected so the user just writes the
// first message.
//
// Uses the imperative `router` singleton (the goToProfile pattern) so it's
// callable from any surface without a hook. Best-effort: a lookup failure
// falls through to the compose screen — createTitleChat's own 23505
// handling still lands in the existing chat on send, so the worst case is
// one extra compose step, never a dead tap.
export async function goToChatAboutTitle(args: {
    otherUserId: string;
    tmdbId: number;
    mediaType: 'movie' | 'tv';
}): Promise<void> {
    const { otherUserId, tmdbId, mediaType } = args;
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (userId) {
            const existingId = await findTitleChat(
                userId,
                otherUserId,
                tmdbId,
                mediaType,
            );
            if (existingId) {
                router.push(`/chat/${existingId}`);
                return;
            }
        }
    } catch (err) {
        console.warn('chat lookup failed, falling through to compose:', err);
    }
    router.push({
        pathname: '/title/[mediaType]/[tmdbId]/chat',
        params: {
            mediaType,
            tmdbId: String(tmdbId),
            preselect: otherUserId,
            // Overlap doors (banner / inbox row → watcher pick) reach the
            // compose screen through here EXCLUSIVELY, so this one param
            // covers both: the message placeholder becomes "Worth
            // watching?" (you're asking someone who's seen it) instead of
            // the generic "Have you seen this?".
            intent: 'overlap',
        },
    });
}

// One-tap send: create/open the chat about this title AND post `message`,
// then land the user in the thread with it already sent. Powers the
// overlap picker's quick chips and the watched-by sheet's chat icon.
//
// createTitleChat is the "ensure chat + post message" primitive — it
// handles BOTH cases transparently: a new chat inserts + posts; an
// existing one (23505, direction-agnostic pair-unique) posts to that same
// thread. So quick-send behaves identically whether or not a chat already
// exists; the message just appends.
//
// Best-effort fallbacks land the user somewhere useful rather than dead:
// no session, or any create/post failure, falls through to the compose
// screen (goToChatAboutTitle) — where createTitleChat's own 23505 handling
// still recovers the existing thread on send.
export async function quickSendAboutTitle(args: {
    otherUserId: string;
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    message: string;
}): Promise<void> {
    const { otherUserId, tmdbId, mediaType, message } = args;
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (!userId) {
            await goToChatAboutTitle({ otherUserId, tmdbId, mediaType });
            return;
        }
        const chatId = await createTitleChat({
            userId,
            otherUserId,
            tmdbId,
            mediaType,
            firstMessage: message,
        });
        router.push(`/chat/${chatId}`);
    } catch (err) {
        console.warn('quick-send failed, falling through to compose:', err);
        await goToChatAboutTitle({ otherUserId, tmdbId, mediaType });
    }
}
