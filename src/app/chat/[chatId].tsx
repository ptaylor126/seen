import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
    CaretRight,
    X,
} from 'phosphor-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    AppState,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import {
    KeyboardStickyView,
    useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { LoadError } from '@/components/load-error';
import { Text } from '@/components/text';
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
    posterFrame,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// The other party's avatar in the identity row, at the EXPANDED size. The
// header collapses on scroll/keyboard by scaling this row down on the UI
// thread, so the avatar renders once at full size and never re-lays-out.
const IDENTITY_AVATAR_SIZE = 44;
// Collapse tuning. The header shrinks as EITHER the thread scrolls up off the
// bottom OR the keyboard opens — combined into a single 0→1 value (a max, not
// two competing animations). COLLAPSE_SCROLL_DISTANCE is how far (px) you
// scroll up from the bottom to reach full collapse; TITLE_CHIP_HEIGHT is the
// title bar's fixed height (poster 60 + paddingVertical spacing.sm ×2), which
// the wrapper collapses; the identity row scales to IDENTITY_COLLAPSED_SCALE.
const COLLAPSE_SCROLL_DISTANCE = 72;
const TITLE_CHIP_HEIGHT = 76;
const IDENTITY_COLLAPSED_SCALE = 0.72;
// The title chip shrinks WITH the identity rather than vanishing — same idea,
// scaled down and kept visible/tappable. Its wrapper height tracks this scale
// (TITLE_CHIP_HEIGHT × scale) so the shrink reclaims a little room with no gap
// or clip.
const TITLE_COLLAPSED_SCALE = 0.72;

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
    // Keyboard height + progress as shared values — the SAME keyboard clock the
    // composer rides (KeyboardStickyView + the composer's own inset). Both are
    // read on the UI thread: `progress` (0 closed → 1 open) drives the header
    // collapse; `height` drives the message list's animated bottom spacer, so
    // the newest messages lift in lockstep with the risen composer instead of
    // snapping (the old JS-state height stepped in one re-render → a jump). The
    // ScrollView itself is never transformed, so its scroll geometry stays
    // correct with the keyboard open.
    const { height: keyboardHeightSV, progress: keyboardProgress } =
        useReanimatedKeyboardAnimation();
    // Scroll-driven collapse (0 at the bottom → 1 scrolled up into history),
    // written on the UI thread by the scroll handler. Combined with the
    // keyboard progress via max() into the single collapse value the header
    // animates off — so scroll and keyboard never fight.
    const scrollCollapse = useSharedValue(0);
    // UI-thread mirror of nearBottomRef, so the scroll worklet only crosses to
    // JS (for the new-message pill) when the boolean actually flips.
    const nearBottomShared = useSharedValue(true);
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
    const scrollRef = useRef<Animated.ScrollView>(null);
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
    // Called from the scroll worklet only when near-bottom flips (not per
    // frame). Owns the JS-side pill/auto-scroll state; the collapse itself
    // stays on the UI thread.
    const applyNearBottom = useCallback((near: boolean) => {
        nearBottomRef.current = near;
        if (near) setShowNewMessagePill(false);
    }, []);

    // Single UI-thread scroll handler: (1) maps distance-from-bottom to the
    // scroll-collapse value, and (2) flips near-bottom to JS on change. The
    // list is bottom-anchored, so at rest distanceFromBottom = 0 (expanded);
    // scrolling up into history grows it toward full collapse.
    const scrollHandler = useAnimatedScrollHandler((e) => {
        const maxOffset = e.contentSize.height - e.layoutMeasurement.height;
        const distanceFromBottom = maxOffset - e.contentOffset.y;
        scrollCollapse.value = interpolate(
            distanceFromBottom,
            [0, COLLAPSE_SCROLL_DISTANCE],
            [0, 1],
            Extrapolation.CLAMP,
        );
        const near =
            e.contentOffset.y + e.layoutMeasurement.height >=
            e.contentSize.height - e.layoutMeasurement.height;
        if (near !== nearBottomShared.value) {
            nearBottomShared.value = near;
            runOnJS(applyNearBottom)(near);
        }
    });

    // The one collapse value both inputs fold into (a max — whichever wants
    // the header smaller wins). 0 = fully expanded, 1 = fully collapsed.
    // Header container: tightens its top/bottom padding as it collapses.
    const topSectionStyle = useAnimatedStyle(() => {
        const c = Math.max(scrollCollapse.value, keyboardProgress.value);
        return {
            paddingTop: interpolate(
                c,
                [0, 1],
                [insets.top + spacing.base, insets.top + spacing.sm],
                Extrapolation.CLAMP,
            ),
            paddingBottom: interpolate(
                c,
                [0, 1],
                [spacing.sm, spacing.xs],
                Extrapolation.CLAMP,
            ),
        };
    });
    // Identity row: scales down (avatar + name together) and drops its gap to
    // the title as it collapses. Transform-only, so it never re-lays-out.
    const identityStyle = useAnimatedStyle(() => {
        const c = Math.max(scrollCollapse.value, keyboardProgress.value);
        return {
            transform: [
                {
                    scale: interpolate(
                        c,
                        [0, 1],
                        [1, IDENTITY_COLLAPSED_SCALE],
                        Extrapolation.CLAMP,
                    ),
                },
            ],
            marginBottom: interpolate(
                c,
                [0, 1],
                [spacing.sm, 0],
                Extrapolation.CLAMP,
            ),
        };
    });
    // Title chip: shrinks WITH the header instead of vanishing — the wrapper
    // height tracks the content's scale (TITLE_CHIP_HEIGHT × scale), so it gets
    // smaller like the identity row above it — no fade, no clip, still tappable.
    const titleChipWrapStyle = useAnimatedStyle(() => {
        const c = Math.max(scrollCollapse.value, keyboardProgress.value);
        return {
            height: interpolate(
                c,
                [0, 1],
                [TITLE_CHIP_HEIGHT, TITLE_CHIP_HEIGHT * TITLE_COLLAPSED_SCALE],
                Extrapolation.CLAMP,
            ),
        };
    });
    // The chip's content scale — paired with the wrapper height above so the
    // scaled pill fits its box exactly (67 × scale on both) and stays centered.
    const titleChipScaleStyle = useAnimatedStyle(() => {
        const c = Math.max(scrollCollapse.value, keyboardProgress.value);
        return {
            transform: [
                {
                    scale: interpolate(
                        c,
                        [0, 1],
                        [1, TITLE_COLLAPSED_SCALE],
                        Extrapolation.CLAMP,
                    ),
                },
            ],
        };
    });
    // Animated bottom spacer for the message list. The composer rides up on the
    // keyboard's native clock; this lifts the newest messages by the SAME live
    // keyboard height (UI thread) so they track it smoothly instead of jumping
    // when a JS-state height steps in. Rests at spacing.base (closed), grows to
    // keyboard height + spacing.sm (open). abs() is sign-agnostic — the shared
    // value is signed for translateY use.
    const bottomSpacerStyle = useAnimatedStyle(() => {
        const kb = Math.abs(keyboardHeightSV.value);
        return {
            height: Math.max(spacing.base, kb + spacing.sm),
        };
    });
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

    // No manual keyboard listener: the composer rides the keyboard via
    // KeyboardStickyView (native clock), the message list bottom-anchors and
    // gets a keyboard-height paddingBottom so the newest messages clear the
    // risen composer, and the composer's own inset self-animates on the
    // keyboard progress — all one keyboard, no competing container animation.

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

    // No focus-scroll: the bottom-anchored message list already hugs the
    // composer, and on the keyboard rise the ScrollView's paddingBottom lifts
    // the newest messages clear of the risen composer. Keeping the user's
    // scroll position on focus is also the correct behaviour (iMessage/
    // WhatsApp don't jump to bottom when you tap the field).

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
            <X color={palette.text} size={20} />
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
            {/* FIXED top section (iMessage model): a compact bar — identity
                row + title chip — pinned at the top, OUTSIDE the scroll, so it
                can't be dragged down by the message list's bottom-anchor and
                stays glanceable at any scroll position. It COLLAPSES (padding,
                identity scale, title height) off a single 0→1 value driven by
                scroll + keyboard on the UI thread, so the list below doesn't
                shimmy. The centered bar and the top-right close button share
                the same Y band at different X, so they coexist. */}
            <Animated.View style={[styles.topSection, topSectionStyle]}>
                {/* Identity row (iMessage-style): the OTHER party's avatar +
                    "You & {name}" inline, centered as a unit. Perspective-
                    shifts by viewer, never shows your own avatar. Scales down
                    as the header collapses. */}
                <Animated.View style={[styles.identityHeader, identityStyle]}>
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
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        You & {otherFirstName}
                    </Text>
                </Animated.View>

                {/* Thin tappable title chip — small poster + "{Title} · {type}"
                    + chevron, through to the full title page. A pill, not a
                    card. Outer wrapper animates HEIGHT, inner animates SCALE
                    (paired) so the chip shrinks with the header — like the
                    identity row — instead of folding away. */}
                <Animated.View
                    style={[styles.titleChipWrap, titleChipWrapStyle]}
                >
                    <Animated.View style={titleChipScaleStyle}>
                        <Pressable
                            onPress={() =>
                                router.push(
                                    `/title/${chat.mediaType}/${chat.tmdbId}`,
                                )
                            }
                            accessibilityRole="link"
                            accessibilityLabel={`View details for ${titleMeta.title}`}
                            style={({ pressed }) => [
                                styles.titleChip,
                                {
                                    backgroundColor: palette.surface,
                                    opacity: pressed ? 0.7 : 1,
                                },
                            ]}
                        >
                            {titleMeta.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(
                                            titleMeta.posterPath,
                                            'w185',
                                        ),
                                    }}
                                    style={styles.titleChipPoster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.titleChipPoster,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <View style={styles.titleChipText}>
                                <Text
                                    style={[
                                        typography.body,
                                        styles.titleChipTitle,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {titleMeta.title}
                                </Text>
                                {chat.season !== null &&
                                chat.episode !== null ? (
                                    // Episode chat — the ONLY spoiler label in
                                    // v1, so accent-coloured to be unmissable.
                                    // Coordinate only, never the episode name
                                    // (episode titles are frequent spoilers).
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.accent },
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {` · Season ${chat.season} · Episode ${chat.episode}`}
                                    </Text>
                                ) : (
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.textMuted },
                                        ]}
                                    >
                                        {` · ${
                                            chat.mediaType === 'movie'
                                                ? 'Movie'
                                                : 'TV'
                                        }`}
                                    </Text>
                                )}
                            </View>
                            <CaretRight
                                color={palette.textMuted}
                                size={18}
                            />
                        </Pressable>
                    </Animated.View>
                </Animated.View>
            </Animated.View>

            {/* Message list — fills between the fixed header and the composer,
                bottom-anchored (short threads hug the composer). Relative
                wrapper so the "New message ↓" pill floats above the composer.
                The ScrollView is NOT transformed; when the keyboard is up its
                paddingBottom lifts the newest messages clear of the risen
                composer, and its scroll geometry stays correct. */}
            <View style={styles.flex}>
                <Animated.ScrollView
                    ref={scrollRef}
                    style={styles.flex}
                    onScroll={scrollHandler}
                    // UI-thread handler drives the collapse — needs per-frame
                    // events (16ms) to track the keyboard/scroll smoothly.
                    scrollEventThrottle={16}
                    onContentSizeChange={handleContentSizeChange}
                    // A real user drag always releases the arrival pin — they
                    // own the scroll position from that moment.
                    onScrollBeginDrag={() => {
                        pinToBottomRef.current = false;
                    }}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    <View style={styles.bodyPad}>
                        <ThreadCommentList
                            comments={comments}
                            myUserId={myUserId}
                            commentReactions={commentReactions}
                            onLongPressComment={setCommentMenuFor}
                        />
                    </View>
                    {/* Animated bottom clearance — lifts the newest messages
                        smoothly with the rising composer/keyboard (see
                        bottomSpacerStyle). Last child, so the bottom-anchored
                        content sits directly above it. */}
                    <Animated.View style={bottomSpacerStyle} />
                </Animated.ScrollView>

                {/* Floating "New message ↓" — shown when a message landed
                    while the user was up in history. Tap scrolls to the end;
                    scrolling to the bottom yourself also clears it (see
                    applyNearBottom). Accent pill, same fill/radius language as
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

            {/* Composer pinned to the keyboard via KeyboardStickyView (native
                clock → rides the keyboard exactly, no lag). Its flow slot
                reserves the bar's height at the bottom; the composer's own
                bottom padding self-animates (home-indicator inset closed →
                small gap open) on the same keyboard progress. */}
            <KeyboardStickyView>
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
                    // Auto-focus only a brand-new (empty) thread — you're there
                    // to write the first message. An existing thread opens at
                    // rest, keyboard down, so you read first and the header
                    // stays expanded until you scroll or tap the field (the
                    // platform-standard open-a-conversation behaviour).
                    autoFocus={comments.length === 0}
                    avatarUrl={myProfile?.avatarUrl ?? null}
                    avatarDisplayName={myProfile?.displayName ?? '?'}
                    avatarSeedId={myUserId ?? chat.id}
                />
            </KeyboardStickyView>

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
    // Fixed compact header bar (identity row + title chip), OUTSIDE the scroll
    // so the message list's bottom-anchor can't drag it down. Its top/bottom
    // padding is animated (topSectionStyle) — the safe-area + a gap that
    // tightens as it collapses.
    topSection: {},
    scrollContent: {
        // flexGrow + flex-end BOTTOM-ANCHOR the messages: short threads hug
        // the composer (newest just above it) instead of floating at the top.
        // Bottom clearance is an animated spacer (last child, bottomSpacerStyle)
        // rather than paddingBottom, so it tracks the keyboard smoothly.
        flexGrow: 1,
        justifyContent: 'flex-end',
    },
    // Tappable title bar: small poster + title · type + chevron. Spans the
    // width (margin, not content-hugging) so it reads as a wide bar under the
    // centered identity. Surface-filled, no shadow — a rounded bar, not a
    // lifted card.
    titleChip: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: spacing.base,
        gap: spacing.sm,
        paddingLeft: spacing.sm,
        paddingRight: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.lg,
    },
    titleChipPoster: {
        ...posterFrame,
        width: 40,
        height: 60,
        // Nested-radius rule: inner = outer − padding. The bar's corner is
        // radius.lg (24) and the poster is inset spacing.sm (8) on its top/
        // left/bottom, so its corners are 24 − 8 = 16 to stay concentric with
        // the bar's rounding rather than looking pasted on.
        borderRadius: radius.lg - spacing.sm,
    },
    // Title + "· type" group; flex:1 fills the bar so the chevron pins to the
    // right edge and the title truncates instead of pushing it off.
    titleChipText: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    titleChipTitle: {
        // Shrinks so a long title truncates while the "· type" stays.
        flexShrink: 1,
    },
    bodyPad: {
        paddingHorizontal: spacing.base,
    },
    // Compact single-line identity row: avatar + "You & {name}" inline,
    // centered as a unit. Its scale + marginBottom animate (identityStyle).
    identityHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
    },
    // Height-collapsing wrapper for the title chip: overflow-clipped so the
    // chip folds away cleanly, centered so it clips evenly top/bottom as the
    // height animates to 0.
    titleChipWrap: {
        overflow: 'hidden',
        justifyContent: 'center',
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
