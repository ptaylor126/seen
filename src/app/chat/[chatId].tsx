import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    Keyboard,
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
    ThreadIncomingReaction,
    ThreadReactionPicker,
} from '@/components/thread/reactions';
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
    clearChatReaction,
    deleteChatComment,
    getChatCommentReactions,
    getChatComments,
    getChatReactions,
    getTitleChat,
    postChatComment,
    setChatCommentReaction,
    setChatReaction,
    type TitleChatRow,
} from '@/lib/chats';
import { goToProfile } from '@/lib/profile-nav';
import { promptReport } from '@/lib/report';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    fontFamily,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Small avatar on the "Chat with {name}" line above the thread.
const WITH_LINE_AVATAR_SIZE = 28;

interface ChatTitleMeta {
    title: string;
    year: string;
    posterPath: string | null;
}

// Stable identity for the incoming reaction, persisted per-chat in
// AsyncStorage so the soft pop fires once per NEW reaction — same mechanism
// as the rec screen's reactionSeen marker, under a chat-scoped key.
function reactionIdentity(r: ReactionRow): string {
    return `${r.userId}:${r.emoji}:${r.createdAt ?? ''}`;
}

// "Chat about a title" thread — a conversation between two friends about a
// title, with NO recommendation semantics: no lifecycle/status chrome, no
// Save/Decline, no "X recommends" framing, no full-bleed hero. A compact
// tappable title header + a light "Chat with {name}" line, then the shared
// thread components wired to the chat_* tables.
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
    const [reactions, setReactions] = useState<ReactionRow[]>([]);
    // Gates the one-time soft pop on the incoming reaction (local last-seen
    // marker chatReactionSeen:<chatId>), same as the rec screen.
    const [shouldAnimateReaction, setShouldAnimateReaction] = useState(false);
    const [comments, setComments] = useState<CommentRow[]>([]);
    const [commentReactions, setCommentReactions] = useState<
        Map<string, ReactionRow[]>
    >(new Map());
    const [reactionBusy, setReactionBusy] = useState(false);
    const [commentReactionBusy, setCommentReactionBusy] = useState<
        string | null
    >(null);
    const [commentMenuFor, setCommentMenuFor] =
        useState<CommentMenuTarget | null>(null);
    const [composer, setComposer] = useState('');
    const [composerBusy, setComposerBusy] = useState(false);
    const scrollRef = useRef<ScrollView | null>(null);
    const [keyboardOpen, setKeyboardOpen] = useState(false);

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

            const [profilesResult, commentRows, reactionRows, titleResult] =
                await Promise.all([
                    supabase
                        .from('profiles')
                        .select('id, display_name, avatar_url')
                        .in('id', [chatRow.fromUserId, chatRow.toUserId]),
                    getChatComments(chatId),
                    getChatReactions(chatId),
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

            const validReactions: ReactionRow[] = [];
            for (const r of reactionRows) {
                if (isReactionEmoji(r.emoji)) {
                    validReactions.push({
                        userId: r.userId,
                        emoji: r.emoji,
                        createdAt: r.createdAt,
                    });
                }
            }
            // One-time incoming-reaction pop, from the LOCAL last-seen
            // marker — read BEFORE setState so flag + reactions land in the
            // same render. Best-effort: storage error → no animation.
            const incoming = validReactions.find((r) => r.userId !== userId);
            let animate = false;
            if (incoming) {
                try {
                    const seen = await AsyncStorage.getItem(
                        `chatReactionSeen:${chatId}`,
                    );
                    animate = seen !== reactionIdentity(incoming);
                } catch {
                    animate = false;
                }
            }
            setShouldAnimateReaction(animate);
            setReactions(validReactions);

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

    useEffect(() => {
        void load();
    }, [load]);

    // Derived reaction views — mine drives the picker's selected state, the
    // other party's renders read-only below it.
    const myReaction: ReactionEmoji | null = myUserId
        ? reactions.find((r) => r.userId === myUserId)?.emoji ?? null
        : null;
    const otherReaction = myUserId
        ? reactions.find((r) => r.userId !== myUserId) ?? null
        : null;

    // Persist the last-seen incoming-reaction identity AFTER render — same
    // one-time-pop mechanism as the rec screen, chat-scoped key.
    useEffect(() => {
        if (!otherReaction) return;
        void AsyncStorage.setItem(
            `chatReactionSeen:${chatId}`,
            reactionIdentity(otherReaction),
        );
    }, [otherReaction, chatId]);

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

    // Chat-level reaction — symmetric: BOTH parties can react (unlike recs,
    // where the picker is recipient-only). Optimistic with rollback.
    async function handleReactionTap(emoji: ReactionEmoji) {
        if (!myUserId || !chat || reactionBusy) return;
        const removing = myReaction === emoji;
        const previous = reactions;
        setReactions((prev) => {
            const withoutMine = prev.filter((r) => r.userId !== myUserId);
            return removing
                ? withoutMine
                : [...withoutMine, { userId: myUserId, emoji }];
        });
        setReactionBusy(true);
        try {
            if (removing) {
                await clearChatReaction(chat.id, myUserId);
            } else {
                await setChatReaction(chat.id, myUserId, emoji);
            }
        } catch (err) {
            setReactions(previous);
            console.error('chat reaction update failed:', err);
            Alert.alert(
                "Couldn't react",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setReactionBusy(false);
        }
    }

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
                await setChatCommentReaction(commentId, myUserId, emoji);
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
                <ScrollView
                    ref={scrollRef}
                    style={styles.flex}
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
                        {/* Light framing of who this thread is with — small
                            avatar + "Chat with {name}", mirroring the rec
                            screen's attribution-line voice without any
                            "recommends" verb. */}
                        <View style={styles.withLine}>
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
                                    size={WITH_LINE_AVATAR_SIZE}
                                />
                            </UserLink>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                                numberOfLines={1}
                            >
                                Chat with{' '}
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.withName,
                                        { color: palette.accent },
                                    ]}
                                    onPress={
                                        otherProfile
                                            ? () =>
                                                  goToProfile({
                                                      userId: otherProfile.userId,
                                                  })
                                            : undefined
                                    }
                                >
                                    {otherFirstName}
                                </Text>
                            </Text>
                        </View>

                        {/* Chat-level reactions — symmetric (both parties). */}
                        <ThreadReactionPicker
                            selected={myReaction}
                            busy={reactionBusy}
                            onTap={handleReactionTap}
                        />
                        {otherReaction ? (
                            <ThreadIncomingReaction
                                reaction={otherReaction}
                                profile={otherProfile}
                                animate={shouldAnimateReaction}
                            />
                        ) : null}

                        <ThreadCommentList
                            comments={comments}
                            myUserId={myUserId}
                            commentReactions={commentReactions}
                            onLongPressComment={setCommentMenuFor}
                        />
                    </View>
                </ScrollView>

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
    // Compact tappable title card: poster thumb + title/year + chevron.
    // Surface-filled so it reads as one control, inset from the edges.
    titleHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginHorizontal: spacing.base,
        padding: spacing.sm,
        borderRadius: radius.md,
    },
    titlePoster: {
        width: 48,
        height: 72,
        borderRadius: radius.sm,
    },
    titleHeaderText: {
        flex: 1,
        gap: spacing.xs,
    },
    bodyPad: {
        paddingHorizontal: spacing.base,
    },
    withLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: spacing.md,
    },
    withName: {
        // Bold Geist on the name chunk — mirrors the rec screen's
        // attribution-line name treatment.
        fontFamily: fontFamily.bold,
        fontWeight: '700',
    },
});
