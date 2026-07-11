import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    AppState,
    Keyboard,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { LoadError } from '@/components/load-error';
import { ThreadCommentList } from '@/components/thread/comment-list';
import { ThreadCommentMenu } from '@/components/thread/comment-menu';
import { ThreadComposer } from '@/components/thread/composer';
import {
    COMMENT_MAX_CHARS,
    type CommentMenuTarget,
    type CommentRow,
    isReactionEmoji,
    type PartyProfile,
    type ReactionEmoji,
    type ReactionRow,
} from '@/components/thread/shared';
import { UserLink } from '@/components/user-link';
import {
    clearChatCommentReaction,
    deleteChatComment,
    getChatCommentReactions,
    getChatComments,
    getTitleChat,
    postChatComment,
    setChatCommentReaction,
    type TitleChatRow,
} from '@/lib/chats';
import { useThreadRealtime } from '@/hooks/use-thread-realtime';
import { promptReport } from '@/lib/report';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// The other party's avatar in the centered identity header.
const IDENTITY_AVATAR_SIZE = 56;

interface ChatTitleMeta {
    title: string;
    year: string;
    posterPath: string | null;
}

// "Chat about a title" thread — a conversation between two friends about a
// title, with NO recommendation semantics: no lifecycle/status chrome, no
// Save/Decline, no "X recommends" framing, no full-bleed hero. A compact
// tappable title header + a light "Chat with {name}" line, then the shared
// thread components wired to the chat_* tables. Reactions are MESSAGE-level
// only (the long-press menu + chips) — the chat-level picker/incoming row
// were removed by design (2026-07-10 device pass).
export default function ChatScreen() {
    const params = useLocalSearchParams<{ chatId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    const chatId = typeof params.chatId === 'string' ? params.chatId : '';

    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    // true for transient/load failures (connection, TMDB) → "Try again";
    // false for terminal states (invalid / not found / no access).
    const [canRetry, setCanRetry] = useState(false);
    const [myUserId, setMyUserId] = useState<string | null>(null);
    const [chat, setChat] = useState<TitleChatRow | null>(null);
    const [titleMeta, setTitleMeta] = useState<ChatTitleMeta | null>(null);
    // The two parties. `me` renders the composer avatar; `other` the header
    // framing + incoming reaction row.
    const [myProfile, setMyProfile] = useState<PartyProfile | null>(null);
    const [otherProfile, setOtherProfile] = useState<PartyProfile | null>(null);
    const [comments, setComments] = useState<CommentRow[]>([]);
    const [commentReactions, setCommentReactions] = useState<
        Map<string, ReactionRow[]>
    >(new Map());
    const [commentReactionBusy, setCommentReactionBusy] = useState<
        string | null
    >(null);
    const [commentMenuFor, setCommentMenuFor] =
        useState<CommentMenuTarget | null>(null);
    const [composer, setComposer] = useState('');
    const [composerBusy, setComposerBusy] = useState(false);
    const scrollRef = useRef<ScrollView | null>(null);
    const [keyboardOpen, setKeyboardOpen] = useState(false);
    // Whether the user is at/near the bottom of the thread (within ~one
    // screen). Drives the new-message auto-scroll: content arriving via a
    // load() refetch (realtime / focus / foreground) scrolls to the bottom
    // only when they were already there — never yanks them out of history.
    // Ref (not state): read inside the comments effect, no re-render needed.
    // Starts true so a fresh arrival lands at the latest message.
    const nearBottomRef = useRef(true);
    // Previous comment count — the auto-scroll fires only when it GROWS
    // (a reaction-only refetch must not scroll).
    const prevCommentCountRef = useRef(0);
    // Arrival pin: while true, every content-size change re-scrolls to the
    // end (unanimated). A one-shot timer raced the initial many-row layout —
    // the scroll landed mid-list or at the top, AND the failed arrival left
    // nearBottomRef's initial `true` misdescribing the position (the
    // yank-from-history bug). onContentSizeChange fires on each growth, so
    // pinning there holds the bottom through the row/avatar/image settle.
    const pinToBottomRef = useRef(false);
    // "New message ↓" pill — shown when a new message lands while the user
    // is up in history (position held). Tap or reaching the bottom clears it.
    const [showNewMessagePill, setShowNewMessagePill] = useState(false);

    // Single loader for the whole screen — chat row first, then the
    // dependent fetches (profiles, TMDB title, comments, reactions) in
    // parallel. Mirrors the rec screen's load shape.
    const load = useCallback(async () => {
        if (!chatId) {
            setError('This chat link is invalid.');
            setCanRetry(false);
            setLoading(false);
            return;
        }
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id ?? null;
            if (!userId) throw new Error('Not authenticated');
            setMyUserId(userId);

            const chatRow = await getTitleChat(chatId);
            if (!chatRow) {
                // RLS returns no row for non-parties/blocked pairs, so
                // "gone" and "no access" are indistinguishable — by design.
                setError('This chat is no longer available.');
                setCanRetry(false);
                setLoading(false);
                return;
            }
            // RLS scopes chats to their two parties, so a non-party would get
            // null above. Explicit guard = defence in depth (same as the rec
            // screen's party check).
            if (
                userId !== chatRow.fromUserId &&
                userId !== chatRow.toUserId
            ) {
                setError("You don't have access to this chat.");
                setCanRetry(false);
                setLoading(false);
                return;
            }
            const otherUserId =
                userId === chatRow.fromUserId
                    ? chatRow.toUserId
                    : chatRow.fromUserId;

            const [profilesResult, commentRows, titleResult] =
                await Promise.all([
                    supabase
                        .from('profiles')
                        .select('id, display_name, avatar_url')
                        .in('id', [chatRow.fromUserId, chatRow.toUserId]),
                    getChatComments(chatId),
                    (chatRow.mediaType === 'movie'
                        ? getMovie(chatRow.tmdbId)
                        : getTV(chatRow.tmdbId)
                    ).then<ChatTitleMeta>((data) => ({
                        title:
                            'title' in data
                                ? data.title
                                : data.name,
                        year: (('release_date' in data
                            ? data.release_date
                            : data.first_air_date) ?? ''
                        ).slice(0, 4),
                        posterPath: data.poster_path,
                    })),
                ]);

            // Mark this chat's notifications read. Best-effort; note that
            // until step 4 lands these kinds have no inbox row, so this is
            // also what keeps the bell count from sticking once the
            // recipient opens the chat.
            void supabase
                .from('notifications')
                .update({ read_at: new Date().toISOString() })
                .eq('user_id', userId)
                .in('kind', [
                    'chat_commented',
                    'chat_reacted',
                    'chat_comment_reacted',
                ])
                .is('read_at', null)
                .filter('payload->>chat_id', 'eq', chatId);

            if (profilesResult.error) throw profilesResult.error;

            const profilesById = new Map<string, PartyProfile>();
            for (const p of profilesResult.data ?? []) {
                profilesById.set(p.id, {
                    userId: p.id,
                    displayName: p.display_name,
                    avatarUrl: p.avatar_url,
                });
            }
            setMyProfile(profilesById.get(userId) ?? null);
            setOtherProfile(profilesById.get(otherUserId) ?? null);

            // Comment authors are always the two parties (RLS), both already
            // resolved above. fromWatched is always false — chats have no
            // watched-sheet semantics.
            const resolvedComments: CommentRow[] = commentRows.map((c) => ({
                id: c.id,
                userId: c.userId,
                author: c.userId ? profilesById.get(c.userId) ?? null : null,
                body: c.body,
                createdAt: c.createdAt,
                fromWatched: false,
            }));
            setComments(resolvedComments);

            // Comment reactions: one round-trip after comments resolve
            // (needs the comment ids).
            const commentReactionsMap = new Map<string, ReactionRow[]>();
            const cReactionRows = await getChatCommentReactions(
                resolvedComments.map((c) => c.id),
            );
            for (const r of cReactionRows) {
                if (!isReactionEmoji(r.emoji)) continue;
                const list = commentReactionsMap.get(r.commentId) ?? [];
                list.push({ userId: r.userId, emoji: r.emoji });
                commentReactionsMap.set(r.commentId, list);
            }
            setCommentReactions(commentReactionsMap);

            setChat(chatRow);
            setTitleMeta(titleResult);
        } catch (err) {
            console.error('chat detail load failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load');
            setCanRetry(true);
        } finally {
            setLoading(false);
        }
    }, [chatId]);

    // Load on every navigation focus — initial mount AND refocus (back from
    // the title page, a fresh navigation to this chat). load() never re-sets
    // `loading` after the first resolve, so re-runs refresh the thread in
    // place with no spinner flash — same silent-refresh shape as the inbox.
    useFocusEffect(
        useCallback(() => {
            void load();
        }, [load]),
    );

    // App-foreground fallback: useFocusEffect only fires on navigation focus.
    // It does NOT fire when the OS brings the app back from background with
    // this chat still the focused screen — e.g. a push-tap that foregrounds
    // onto the already-open chat — so the other party's new message would
    // stay missing until leave-and-return. Reloading on AppState 'active'
    // closes that gap. Mirrors the inbox fix (and use-unread-count).
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                void load();
            }
        });
        return () => sub.remove();
    }, [load]);

    // Track proximity to the bottom for the new-message auto-scroll. "Near"
    // = within one screen of the end, so a reader a couple of messages up
    // still follows the conversation, but someone deep in history doesn't.
    // Reaching the bottom (by any means) also clears the new-message pill —
    // the setState bails when already false, so per-event calls are cheap.
    function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
        const { contentOffset, layoutMeasurement, contentSize } =
            e.nativeEvent;
        nearBottomRef.current =
            contentOffset.y + layoutMeasurement.height >=
            contentSize.height - layoutMeasurement.height;
        if (nearBottomRef.current) setShowNewMessagePill(false);
    }

    // While the arrival pin is set, every content growth re-snaps to the end
    // — this is what actually lands the open-at-latest-message scroll (a
    // timer can't; see pinToBottomRef).
    function handleContentSizeChange() {
        if (!pinToBottomRef.current) return;
        scrollRef.current?.scrollToEnd({ animated: false });
    }

    // Auto-scroll when NEW messages land via a load() refetch (realtime,
    // focus, foreground):
    //   - arrival (count 0 → N): pin to the bottom through the initial
    //     layout settle (~1s window, content-size-driven), so the screen
    //     opens at the latest message with no visible scroll;
    //   - at/near the bottom: follow with the same deferred animated
    //     scrollToEnd the composer/keyboard paths use;
    //   - up in history: hold position and show the "New message ↓" pill.
    useEffect(() => {
        const prev = prevCommentCountRef.current;
        prevCommentCountRef.current = comments.length;
        if (comments.length <= prev) return;
        if (prev === 0) {
            pinToBottomRef.current = true;
            scrollRef.current?.scrollToEnd({ animated: false });
            // Release the pin once the initial layout has settled — after
            // this, the follow/hold logic owns scrolling. A user drag inside
            // the window also releases it (onScrollBeginDrag).
            setTimeout(() => {
                pinToBottomRef.current = false;
            }, 1000);
            return;
        }
        if (!nearBottomRef.current) {
            setShowNewMessagePill(true);
            return;
        }
        setTimeout(() => {
            scrollRef.current?.scrollToEnd({ animated: true });
        }, 50);
    }, [comments]);

    // Live thread while focused: any insert/update/delete on THIS chat's
    // comments or comment-reactions triggers a silent load() refetch (own
    // writes included — the reconcile is a no-op visually). Each binding
    // gets its own channel (see the lesson in use-thread-realtime). Comment-
    // reactions filter on the denormalized chat_id (20260710150000). No
    // chat_reactions binding: nothing renders chat-level reactions
    // (message-level only).
    useThreadRealtime({
        topic: `chat:${chatId}`,
        bindings: chatId
            ? [
                  { table: 'chat_comments', filter: `chat_id=eq.${chatId}` },
                  {
                      table: 'chat_comment_reactions',
                      filter: `chat_id=eq.${chatId}`,
                  },
              ]
            : [],
        onEvent: load,
        enabled: !!chatId,
    });

    // Keyboard visibility → composer bottom padding + keep the latest
    // message visible above the shrunk scroll area. Verbatim from the rec
    // screen (same pinned-composer-outside-ScrollView structure).
    useEffect(() => {
        const showEvt =
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvt =
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvt, () => {
            setKeyboardOpen(true);
            scrollRef.current?.scrollToEnd({ animated: true });
            setTimeout(() => {
                scrollRef.current?.scrollToEnd({ animated: true });
            }, 300);
        });
        const hideSub = Keyboard.addListener(hideEvt, () =>
            setKeyboardOpen(false),
        );
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    // Per-comment reaction — same delete-on-active / upsert semantics as the
    // rec screen, against chat_comment_reactions.
    async function handleCommentReactionTap(
        commentId: string,
        emoji: ReactionEmoji,
    ) {
        if (!myUserId || !chat || commentReactionBusy) return;
        setCommentReactionBusy(commentId);
        try {
            const list = commentReactions.get(commentId) ?? [];
            const myCurrent =
                list.find((r) => r.userId === myUserId)?.emoji ?? null;
            if (myCurrent === emoji) {
                await clearChatCommentReaction(commentId, myUserId);
                setCommentReactions((prev) => {
                    const next = new Map(prev);
                    const withoutMine = (next.get(commentId) ?? []).filter(
                        (r) => r.userId !== myUserId,
                    );
                    if (withoutMine.length > 0) {
                        next.set(commentId, withoutMine);
                    } else {
                        next.delete(commentId);
                    }
                    return next;
                });
            } else {
                await setChatCommentReaction(
                    chat.id,
                    commentId,
                    myUserId,
                    emoji,
                );
                setCommentReactions((prev) => {
                    const next = new Map(prev);
                    const withoutMine = (next.get(commentId) ?? []).filter(
                        (r) => r.userId !== myUserId,
                    );
                    next.set(commentId, [
                        ...withoutMine,
                        { userId: myUserId, emoji },
                    ]);
                    return next;
                });
            }
        } catch (err) {
            console.error('chat comment reaction update failed:', err);
            Alert.alert(
                "Couldn't react",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setCommentReactionBusy(null);
        }
    }

    async function handlePostComment() {
        const body = composer.trim();
        if (!body || !myUserId || !chat || composerBusy) return;
        if (body.length > COMMENT_MAX_CHARS) return;
        setComposerBusy(true);
        try {
            const inserted = await postChatComment(chat.id, myUserId, body);
            setComments((prev) => [
                ...prev,
                {
                    id: inserted.id,
                    userId: myUserId,
                    author: myProfile,
                    body,
                    createdAt: inserted.created_at,
                    fromWatched: false,
                },
            ]);
            setComposer('');
            setTimeout(() => {
                scrollRef.current?.scrollToEnd({ animated: true });
            }, 50);
        } catch (err) {
            console.error('post chat comment failed:', err);
            Alert.alert(
                "Couldn't post comment",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setComposerBusy(false);
        }
    }

    function handleComposerFocus() {
        scrollRef.current?.scrollToEnd({ animated: true });
        setTimeout(() => {
            scrollRef.current?.scrollToEnd({ animated: true });
        }, 300);
    }

    function handleDeleteComment(commentId: string) {
        Alert.alert('Delete comment?', 'This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    try {
                        await deleteChatComment(commentId);
                        setComments((prev) =>
                            prev.filter((c) => c.id !== commentId),
                        );
                    } catch (err) {
                        console.error('delete chat comment failed:', err);
                        Alert.alert(
                            "Couldn't delete",
                            err instanceof Error ? err.message : 'Unknown error',
                        );
                    }
                },
            },
        ]);
    }

    const closeButton = (
        <Pressable
            onPress={() => router.back()}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[
                styles.closeButton,
                {
                    top: insets.top + spacing.base,
                    backgroundColor: palette.surface,
                },
            ]}
        >
            <X color={palette.text} size={20} strokeWidth={ICON_STROKE_WIDTH} />
        </Pressable>
    );

    if (showLoader) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                {closeButton}
                <FullScreenLoader />
            </View>
        );
    }
    if (error || !chat || !titleMeta) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                {closeButton}
                <LoadError
                    title={
                        canRetry ? "Couldn't load this chat" : 'Chat unavailable'
                    }
                    message={
                        canRetry
                            ? 'Check your connection and try again.'
                            : error ?? 'This chat isn’t available.'
                    }
                    onRetry={
                        canRetry
                            ? () => {
                                  setError(null);
                                  setLoading(true);
                                  void load();
                              }
                            : undefined
                    }
                />
            </View>
        );
    }

    const otherName = otherProfile?.displayName ?? 'Former user';
    const otherFirstName = otherName.split(/\s+/)[0] || otherName;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {closeButton}
            <KeyboardAvoidingView
                style={styles.flex}
                behavior="padding"
                keyboardVerticalOffset={0}
            >
                {/* Relative wrapper so the "New message ↓" pill can float at
                    the thread's bottom edge, above the composer. */}
                <View style={styles.flex}>
                <ScrollView
                    ref={scrollRef}
                    style={styles.flex}
                    onScroll={handleScroll}
                    // Proximity tracking only needs coarse updates, not
                    // per-frame events.
                    scrollEventThrottle={100}
                    onContentSizeChange={handleContentSizeChange}
                    // A real user drag always releases the arrival pin — they
                    // own the scroll position from that moment.
                    onScrollBeginDrag={() => {
                        pinToBottomRef.current = false;
                    }}
                    contentContainerStyle={[
                        styles.scrollContent,
                        {
                            // Clear the absolute close button (36pt at
                            // insets.top + base) before the header starts.
                            paddingTop: insets.top + spacing.base + 36 + spacing.lg,
                            paddingBottom: insets.bottom + spacing.base,
                        },
                    ]}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* Centered identity header (iMessage-style): the OTHER
                        party's avatar + "You & {name}" — perspective-shifts
                        by viewer, never shows your own avatar. */}
                    <View style={styles.identityHeader}>
                        <UserLink
                            userId={otherProfile?.userId ?? null}
                            disabled={!otherProfile}
                            hitSlop={8}
                            accessibilityLabel={`View ${otherName}'s profile`}
                        >
                            <Avatar
                                avatarUrl={otherProfile?.avatarUrl ?? null}
                                displayName={otherName}
                                seedId={otherProfile?.userId ?? chat.id}
                                size={IDENTITY_AVATAR_SIZE}
                            />
                        </UserLink>
                        <Text
                            style={[
                                typography.heading,
                                { color: palette.text },
                            ]}
                        >
                            You & {otherFirstName}
                        </Text>
                    </View>

                    {/* Compact title header — small poster + title/year,
                        tappable through to the full title page. No hero,
                        no status chrome: a chat has no lifecycle. */}
                    <Pressable
                        onPress={() =>
                            router.push(
                                `/title/${chat.mediaType}/${chat.tmdbId}`,
                            )
                        }
                        accessibilityRole="link"
                        accessibilityLabel={`View details for ${titleMeta.title}`}
                        style={({ pressed }) => [
                            styles.titleHeader,
                            {
                                backgroundColor: palette.surface,
                                opacity: pressed ? 0.7 : 1,
                            },
                        ]}
                    >
                        {titleMeta.posterPath ? (
                            <Image
                                source={{
                                    uri: imageUrl(titleMeta.posterPath, 'w185'),
                                }}
                                style={styles.titlePoster}
                                contentFit="cover"
                                transition={150}
                            />
                        ) : (
                            <View
                                style={[
                                    styles.titlePoster,
                                    { backgroundColor: palette.surfaceAlt },
                                ]}
                            />
                        )}
                        <View style={styles.titleHeaderText}>
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.text },
                                ]}
                                numberOfLines={2}
                            >
                                {titleMeta.title}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {[
                                    titleMeta.year,
                                    chat.mediaType === 'movie' ? 'Movie' : 'TV',
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                        </View>
                        <ChevronRight
                            color={palette.textMuted}
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>

                    <View style={styles.bodyPad}>
                        <ThreadCommentList
                            comments={comments}
                            myUserId={myUserId}
                            commentReactions={commentReactions}
                            onLongPressComment={setCommentMenuFor}
                        />
                    </View>
                </ScrollView>

                {/* Floating "New message ↓" — shown when a message landed
                    while the user was up in history. Tap scrolls to the end;
                    scrolling to the bottom yourself also clears it (see
                    handleScroll). Accent pill, same fill/radius language as
                    the composer's send circle. */}
                {showNewMessagePill ? (
                    <Pressable
                        onPress={() => {
                            setShowNewMessagePill(false);
                            scrollRef.current?.scrollToEnd({ animated: true });
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Scroll to newest message"
                        style={({ pressed }) => [
                            styles.newMessagePill,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.8 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.caption,
                                { color: palette.textInverse },
                            ]}
                        >
                            New message ↓
                        </Text>
                    </Pressable>
                ) : null}
                </View>

                <ThreadComposer
                    value={composer}
                    onChangeText={setComposer}
                    onSend={handlePostComment}
                    busy={composerBusy}
                    placeholder={
                        comments.length === 0
                            ? 'Start a conversation'
                            : 'Add to the conversation…'
                    }
                    keyboardOpen={keyboardOpen}
                    onFocus={handleComposerFocus}
                    avatarUrl={myProfile?.avatarUrl ?? null}
                    avatarDisplayName={myProfile?.displayName ?? '?'}
                    avatarSeedId={myUserId ?? chat.id}
                />
            </KeyboardAvoidingView>

            {/* Long-press popover — react / delete own / report other's.
                Reports use type 'comment' (see reports CHECK); the id points
                at chat_comments. */}
            <ThreadCommentMenu
                menu={commentMenuFor}
                onClose={() => setCommentMenuFor(null)}
                onReact={(commentId, emoji) => {
                    void handleCommentReactionTap(commentId, emoji);
                }}
                onDelete={handleDeleteComment}
                onReport={(commentId, authorId) =>
                    promptReport({
                        type: 'comment',
                        id: commentId,
                        reportedUserId: authorId,
                        title: 'Report comment',
                    })
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    closeButton: {
        position: 'absolute',
        right: spacing.base,
        width: 36,
        height: 36,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    scrollContent: {
        // paddingTop/Bottom applied inline (safe-area + close-button
        // clearance).
    },
    // Compact tappable title card: poster + title/year + chevron. Surface-
    // filled with a soft shadow so it reads as the conversation's anchor,
    // gently lifted off the wash rather than flat against it.
    titleHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginHorizontal: spacing.base,
        padding: spacing.sm,
        borderRadius: radius.md,
        // Subtle elevation — iOS shadow + Android elevation pair.
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 3,
    },
    titlePoster: {
        // Larger than the original 48×72 thumb — the poster is the
        // conversation's visual anchor.
        width: 68,
        height: 102,
        borderRadius: radius.sm,
    },
    titleHeaderText: {
        flex: 1,
        gap: spacing.xs,
    },
    bodyPad: {
        paddingHorizontal: spacing.base,
    },
    identityHeader: {
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.base,
        paddingHorizontal: spacing.base,
    },
    newMessagePill: {
        // Floating over the thread's bottom edge, self-centered. Full-radius
        // accent pill (fill set inline) — the app's pill/chip shape.
        position: 'absolute',
        bottom: spacing.md,
        alignSelf: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
});
