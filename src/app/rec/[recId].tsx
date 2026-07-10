import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight, MoreHorizontal, X, XCircle } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    Dimensions,
    Keyboard,
    type LayoutChangeEvent,
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

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { DeclineSheet } from '@/components/decline-sheet';
import { LoadError } from '@/components/load-error';
import { RatingSheet } from '@/components/rating-sheet';
import { RecActionSheet } from '@/components/rec-action-sheet';
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
    relativeTimestamp,
} from '@/components/thread/shared';
import { UserLink } from '@/components/user-link';
import { useThreadRealtime } from '@/hooks/use-thread-realtime';
import {
    formatLibraryBadge,
    type ItemStatus,
} from '@/lib/item-status';
import { postRecComment } from '@/lib/comments';
import { goToProfile } from '@/lib/profile-nav';
import { type MediaType } from '@/lib/rating';
import { promptReport } from '@/lib/report';
import { maybeRequestReview } from '@/lib/review';
import supabase from '@/lib/supabase';
import { ensureTitle } from '@/lib/titles';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    fontFamily,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Small avatar on the recommender line above the note.
const REC_LINE_AVATAR_SIZE = 28;
// Immersive backdrop header — the hero of the screen (~50% of height).
// Read once at module load (same pattern as the home hero / Top 5 row).
const HEADER_HEIGHT = Math.round(Dimensions.get('window').height * 0.5);

interface RecSummary {
    id: string;
    fromUserId: string | null;
    toUserId: string;
    tmdbId: number;
    mediaType: MediaType;
    note: string | null;
    sentAt: string;
    // Rec lifecycle state. Drives the Decline action's gate (recipient +
    // 'pending' only) and is flipped optimistically on decline / undo.
    status: string;
}

interface TitleMeta {
    title: string;
    year: string;
    posterPath: string | null;
    // Wide TMDB backdrop for the immersive header — the same image the
    // home hero card uses, resolved through the shared imageUrl() util.
    backdropPath: string | null;
    // Extra TMDB fields needed to stamp the shared `titles` catalogue via
    // ensureTitle when the recipient adds this title to their library
    // (send_recommendation doesn't stamp titles, so the row may not exist).
    releaseDate: string | null;
    originalLanguage: string;
    genreIds: number[];
}

// Stable identity for the incoming reaction, persisted per-rec in AsyncStorage
// so the soft pop fires once per NEW reaction. Emoji + created_at means a
// changed emoji (or a removed-then-re-added reaction) reads as new and pops
// again — desired. The reactions table has no single-column id (PK is
// recommendation_id + user_id), hence the composite string.
function reactionIdentity(r: ReactionRow): string {
    return `${r.userId}:${r.emoji}:${r.createdAt ?? ''}`;
}

export default function RecScreen() {
    const params = useLocalSearchParams<{ recId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    const recId = typeof params.recId === 'string' ? params.recId : '';

    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    // Whether the current error is worth a retry. true for transient/load
    // failures (connection, TMDB) → show "Try again"; false for terminal
    // states (invalid / not found / no access) → friendly message, no button.
    const [canRetry, setCanRetry] = useState(false);
    const [myUserId, setMyUserId] = useState<string | null>(null);
    const [rec, setRec] = useState<RecSummary | null>(null);
    const [titleMeta, setTitleMeta] = useState<TitleMeta | null>(null);
    const [sender, setSender] = useState<PartyProfile | null>(null);
    const [recipient, setRecipient] = useState<PartyProfile | null>(null);
    const [reactions, setReactions] = useState<ReactionRow[]>([]);
    // True only when the incoming reaction is NEW vs the local last-seen marker
    // (reactionSeen:<recId> in AsyncStorage) — gates the one-time soft pop on
    // the incoming (otherReaction) reaction so it animates when new, not on
    // every mount/focus return. Decided in load(), persisted after render.
    const [shouldAnimateReaction, setShouldAnimateReaction] = useState(false);
    const [comments, setComments] = useState<CommentRow[]>([]);
    // commentReactions: comment_id → reactions on that comment.
    // Stored as a Map so per-comment lookups in the render path are O(1).
    const [commentReactions, setCommentReactions] = useState<
        Map<string, ReactionRow[]>
    >(new Map());
    const [reactionBusy, setReactionBusy] = useState(false);
    // Tracks which comment's reaction write is in flight so we only
    // disable that comment's picker, not every comment's.
    const [commentReactionBusy, setCommentReactionBusy] = useState<
        string | null
    >(null);
    // Long-press popover anchored at the touch point of the comment
    // the user pressed — see CommentMenuTarget in thread/shared.
    const [commentMenuFor, setCommentMenuFor] =
        useState<CommentMenuTarget | null>(null);
    const [composer, setComposer] = useState('');
    const [composerBusy, setComposerBusy] = useState(false);
    const scrollRef = useRef<ScrollView | null>(null);
    // New-comment auto-scroll (ported from the chat screen, WITHOUT its
    // arrival pin — this screen always opens on the rec itself, never the
    // thread). Near-bottom is MEASUREMENT-derived (offset + viewport +
    // content height, each from its own event) rather than scroll-only:
    // unlike chat, the user starts at the TOP here, so a scroll-event-only
    // ref with a `true` default would misclassify a never-scrolled reader on
    // a long thread — the chat screen's original yank-from-history bug.
    const scrollOffsetRef = useRef(0);
    const layoutHeightRef = useRef(0);
    const contentHeightRef = useRef(0);
    const nearBottomRef = useRef(true); // accurate until measured: short content = bottom visible
    // Previous comment count — auto-scroll/pill fire only when it GROWS.
    const prevCommentCountRef = useRef(0);
    // "New comment ↓" pill — shown when someone ELSE's comment lands while
    // the user is up at the rec/hero. Tap or reaching the bottom clears it.
    const [showNewMessagePill, setShowNewMessagePill] = useState(false);
    // Whether the keyboard is up — drops the composer's bottom safe-area
    // inset while typing (the keyboard already covers the home-indicator
    // area, so keeping the inset leaves a white gap above the keyboard).
    const [keyboardOpen, setKeyboardOpen] = useState(false);
    // The recipient's library relationship to this title (drives the
    // action button label + the action sheet's selected state). null = not
    // in their library yet.
    const [currentStatus, setCurrentStatus] = useState<ItemStatus | null>(
        null,
    );
    const [currentRating, setCurrentRating] = useState<number | null>(null);
    const [showActionSheet, setShowActionSheet] = useState(false);
    const [showRatingSheet, setShowRatingSheet] = useState(false);
    // Presenting the rating modal while the action-sheet modal is still
    // animating its dismissal is silently dropped on iOS — which left the rec
    // in a half-state and blocked later modals. So a 'watched' pick opens the
    // rating sheet only once BOTH are true: the upsert succeeded
    // (pendingRatingRef) AND the action sheet has fully unmounted
    // (actionSheetClosedRef). Either can win the race — the upsert may resolve
    // before or after the ~180ms close animation — so whichever finishes last
    // calls maybeOpenRatingSheet(). Refs (not state) so the async upsert and
    // the onClosed callback always read the latest values.
    //
    // NOTE: this drop-during-dismissal behaviour is documented for RN
    // <Modal>s ONLY. A 2026-07-10 hypothesis that native-stack router
    // pushes suffer the same swallow was DISPROVEN by instrumentation —
    // that bug was presentation topology instead (a 'card' pushed while a
    // fullScreenModal is presented attaches BEHIND the modal; the screen
    // mounts but never shows). See _layout.tsx's chat/[chatId] registration.
    const pendingRatingRef = useRef(false);
    const actionSheetClosedRef = useRef(true);
    const [statusBusy, setStatusBusy] = useState(false);
    // Decline ("Not for me") flow: the sheet + its in-flight write. A
    // declined rec now stays on screen in a persistent "you passed on this"
    // state with an inline un-decline ("Changed my mind") — no transient
    // undo bar / auto-return.
    const [showDeclineSheet, setShowDeclineSheet] = useState(false);
    const [declineBusy, setDeclineBusy] = useState(false);

    // Single loader for the whole screen — splits into three queries
    // after the rec lookup so the dependent fetches (profiles by id,
    // TMDB title) can run in parallel. Cancellation via `active` so
    // a quick re-mount doesn't race.
    const load = useCallback(async () => {
        if (!recId) {
            setError('This rec link is invalid.');
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

            const { data: recRow, error: recErr } = await supabase
                .from('recommendations')
                .select(
                    'id, from_user_id, to_user_id, tmdb_id, media_type, note, sent_at, status',
                )
                .eq('id', recId)
                .maybeSingle();
            if (recErr) throw recErr;
            if (!recRow) {
                setError('This rec is no longer available.');
                setCanRetry(false);
                setLoading(false);
                return;
            }
            // RLS scopes recommendations to (sender or recipient) so a
            // non-party would get null above. The explicit guard here
            // is defence in depth + a clear branch for the rare case
            // RLS is later loosened.
            const fromUserId = recRow.from_user_id;
            const toUserId = recRow.to_user_id;
            if (userId !== fromUserId && userId !== toUserId) {
                setError("You don't have access to this rec.");
                setCanRetry(false);
                setLoading(false);
                return;
            }
            const mediaType =
                recRow.media_type === 'movie' || recRow.media_type === 'tv'
                    ? (recRow.media_type as MediaType)
                    : null;
            if (!mediaType) {
                setError('This rec is unavailable.');
                setCanRetry(false);
                setLoading(false);
                return;
            }
            const summary: RecSummary = {
                id: recRow.id,
                fromUserId,
                toUserId,
                tmdbId: recRow.tmdb_id,
                mediaType,
                note: recRow.note,
                sentAt: recRow.sent_at,
                status: recRow.status,
            };
            setRec(summary);

            // Fan out: profiles (sender + recipient), reactions,
            // comments + comment author profiles, TMDB title, and a
            // "mark unread rec_reacted/rec_commented notifs for this
            // rec as read" sweep (defence: inbox open also clears
            // them, but a direct rec deep-link bypasses inbox).
            const partyIds = [fromUserId, toUserId].filter(
                (v): v is string => !!v,
            );
            const [
                profilesResult,
                reactionsResult,
                commentsResult,
                titleResult,
                itemResult,
            ] = await Promise.all([
                supabase
                    .from('profiles')
                    .select('id, display_name, avatar_url')
                    .in('id', partyIds),
                supabase
                    .from('recommendation_reactions')
                    .select('user_id, emoji, created_at')
                    .eq('recommendation_id', recId),
                supabase
                    .from('recommendation_comments')
                    .select('id, user_id, body, created_at, from_watched')
                    .eq('recommendation_id', recId)
                    .order('created_at', { ascending: true })
                    // reason: from_watched isn't in the generated types yet
                    // (added live, types not regenerated) — the select-string
                    // parser can't see it, so declare the row shape here.
                    .returns<
                        {
                            id: string;
                            user_id: string | null;
                            body: string;
                            created_at: string;
                            from_watched: boolean;
                        }[]
                    >(),
                (mediaType === 'movie'
                    ? getMovie(summary.tmdbId)
                    : getTV(summary.tmdbId)
                ).then<TitleMeta>((data) => {
                    const rawDate =
                        'release_date' in data
                            ? data.release_date
                            : data.first_air_date;
                    return {
                        title: 'title' in data ? data.title : data.name,
                        year:
                            typeof rawDate === 'string'
                                ? rawDate.slice(0, 4)
                                : '',
                        posterPath: data.poster_path,
                        backdropPath: data.backdrop_path,
                        releaseDate:
                            typeof rawDate === 'string' && rawDate.length > 0
                                ? rawDate
                                : null,
                        originalLanguage: data.original_language,
                        genreIds: data.genres.map((g) => g.id),
                    };
                }),
                // The recipient's existing library row for this title, if
                // any — drives the action button label + the action sheet's
                // selected status.
                supabase
                    .from('items')
                    .select('status, rating')
                    .eq('user_id', userId)
                    .eq('tmdb_id', summary.tmdbId)
                    .eq('media_type', mediaType)
                    .maybeSingle(),
            ]);

            // Mark related notifications read. Best-effort — if it
            // fails the badge stays a beat longer but nothing else
            // breaks.
            void supabase
                .from('notifications')
                .update({ read_at: new Date().toISOString() })
                .eq('user_id', userId)
                .in('kind', ['rec_reacted', 'rec_commented'])
                .is('read_at', null)
                .filter('payload->>recommendation_id', 'eq', recId);

            if (profilesResult.error) throw profilesResult.error;
            if (reactionsResult.error) throw reactionsResult.error;
            if (commentsResult.error) throw commentsResult.error;

            const profilesById = new Map<string, PartyProfile>();
            for (const p of profilesResult.data ?? []) {
                profilesById.set(p.id, {
                    userId: p.id,
                    displayName: p.display_name,
                    avatarUrl: p.avatar_url,
                });
            }
            setSender(fromUserId ? profilesById.get(fromUserId) ?? null : null);
            setRecipient(profilesById.get(toUserId) ?? null);

            const validReactions: ReactionRow[] = [];
            for (const r of reactionsResult.data ?? []) {
                if (r.user_id && isReactionEmoji(r.emoji)) {
                    validReactions.push({
                        userId: r.user_id,
                        emoji: r.emoji,
                        createdAt: r.created_at,
                    });
                }
            }

            // Decide the one-time incoming-reaction pop from a LOCAL last-seen
            // marker (not notifications). Animate only if the other party's
            // current reaction identity differs from what we last stored for
            // this rec (a new reaction, or a changed emoji); no stored key →
            // first view → animate. Read BEFORE setState so the flag and
            // reactions land in the SAME render (moti reads `from` at mount).
            // Best-effort: any storage error → no animation.
            const incoming = validReactions.find((r) => r.userId !== userId);
            let animate = false;
            if (incoming) {
                try {
                    const seen = await AsyncStorage.getItem(
                        `reactionSeen:${recId}`,
                    );
                    animate = seen !== reactionIdentity(incoming);
                } catch {
                    animate = false;
                }
            }
            setShouldAnimateReaction(animate);
            setReactions(validReactions);

            // Resolve comment authors. May include user_ids we don't
            // already have (a third party should be impossible by RLS
            // — only the two parties can comment — but a fresh batch
            // fetch keeps the renderer simple).
            const commentAuthorIds = new Set<string>();
            for (const c of commentsResult.data ?? []) {
                if (c.user_id) commentAuthorIds.add(c.user_id);
            }
            const missing = [...commentAuthorIds].filter(
                (id) => !profilesById.has(id),
            );
            if (missing.length > 0) {
                const { data: extra } = await supabase
                    .from('profiles')
                    .select('id, display_name, avatar_url')
                    .in('id', missing);
                for (const p of extra ?? []) {
                    profilesById.set(p.id, {
                        userId: p.id,
                        displayName: p.display_name,
                        avatarUrl: p.avatar_url,
                    });
                }
            }
            const resolvedComments: CommentRow[] = (
                commentsResult.data ?? []
            ).map((c) => ({
                id: c.id,
                userId: c.user_id,
                author: c.user_id ? profilesById.get(c.user_id) ?? null : null,
                body: c.body,
                createdAt: c.created_at,
                fromWatched: c.from_watched,
            }));
            setComments(resolvedComments);

            // Comment reactions: one round-trip after comments resolve
            // because we need the comment ids to filter. RLS gates by
            // is_party_to_comment so the .in() is the only narrowing
            // we actually need (party scope is enforced server-side),
            // but filtering explicitly avoids pulling reactions on
            // unrelated recs through a single round-trip.
            const commentIds = resolvedComments.map((c) => c.id);
            const commentReactionsMap = new Map<string, ReactionRow[]>();
            if (commentIds.length > 0) {
                const { data: cReactionRows, error: cReactionsError } =
                    await supabase
                        .from('recommendation_comment_reactions')
                        .select('comment_id, user_id, emoji')
                        .in('comment_id', commentIds);
                if (cReactionsError) throw cReactionsError;
                for (const r of cReactionRows ?? []) {
                    if (!r.user_id || !isReactionEmoji(r.emoji)) continue;
                    const list = commentReactionsMap.get(r.comment_id) ?? [];
                    list.push({ userId: r.user_id, emoji: r.emoji });
                    commentReactionsMap.set(r.comment_id, list);
                }
            }
            setCommentReactions(commentReactionsMap);

            setTitleMeta(titleResult);

            // Seed the library status from the recipient's items row.
            const itemRow = itemResult.data;
            if (
                itemRow &&
                (itemRow.status === 'watchlist' ||
                    itemRow.status === 'watching' ||
                    itemRow.status === 'watched')
            ) {
                setCurrentStatus(itemRow.status);
                setCurrentRating(
                    typeof itemRow.rating === 'number' ? itemRow.rating : null,
                );
            }
        } catch (err) {
            // Transient/connection failure (incl. the rec row fetch failing
            // offline, or the TMDB title metadata flaking) — retryable.
            console.error('rec detail load failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load');
            setCanRetry(true);
        } finally {
            setLoading(false);
        }
    }, [recId]);

    useEffect(() => {
        void load();
    }, [load]);

    // Resync the library status + rec lifecycle status whenever the screen
    // regains focus — e.g. the user opened "View details", changed the status
    // on the title screen (which writes items.status/rating, and for 'watched'
    // also transitions THIS rec → watched), then came back. Pushing the title
    // screen leaves this screen mounted, so the mount `load` never re-runs and
    // these would otherwise show stale.
    //
    // Mirrors the title screen's own useFocusEffect: it depends ONLY on the
    // stable `recId` route param (re-deriving tmdb_id/media_type from the DB),
    // so its identity never changes on internal state updates. That matters
    // twice over — it can't re-run when we optimistically setRec during
    // decline/watched, and it's structurally impossible for it to fire mid
    // watched-flow (the action/rating sheets are modals on THIS screen, so the
    // screen never loses focus during that sequence).
    //
    // READ-ONLY into state: it only sets currentStatus / currentRating and (via
    // a functional, diff-guarded update) rec.status. It deliberately does NOT
    // touch pendingRatingRef, actionSheetClosedRef, showRatingSheet,
    // showActionSheet, or statusBusy — the watched-flow modal sequencing must
    // not be perturbed.
    const skipFirstFocusRef = useRef(true);
    useFocusEffect(
        useCallback(() => {
            // Skip the initial mount focus — `load` already read these, so a
            // resync here would just be a redundant round-trip.
            if (skipFirstFocusRef.current) {
                skipFirstFocusRef.current = false;
                return;
            }
            if (!recId) return;
            let active = true;
            (async () => {
                try {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    const uid = session?.user.id;
                    if (!uid || !active) return;

                    // Re-read the rec's lifecycle status + its title
                    // coordinates together, so we can resync the library row
                    // without depending on the loaded `rec` object.
                    const { data: recRow, error: recErr } = await supabase
                        .from('recommendations')
                        .select('status, tmdb_id, media_type')
                        .eq('id', recId)
                        .maybeSingle();
                    if (!active || recErr || !recRow) return;

                    const { data: itemRow, error: itemErr } = await supabase
                        .from('items')
                        .select('status, rating')
                        .eq('user_id', uid)
                        .eq('tmdb_id', recRow.tmdb_id)
                        .eq('media_type', recRow.media_type)
                        .maybeSingle();
                    if (!active) return;

                    // Library status + rating. A present row with a known
                    // status updates both; an absent row means the title was
                    // removed from the library on the title screen → clear
                    // back to "not in library". Skip on a query error so a
                    // network blip doesn't wipe the displayed status.
                    if (!itemErr) {
                        if (
                            itemRow &&
                            (itemRow.status === 'watchlist' ||
                                itemRow.status === 'watching' ||
                                itemRow.status === 'watched')
                        ) {
                            setCurrentStatus(itemRow.status);
                            setCurrentRating(
                                typeof itemRow.rating === 'number'
                                    ? itemRow.rating
                                    : null,
                            );
                        } else {
                            setCurrentStatus(null);
                            setCurrentRating(null);
                        }
                    }

                    // Rec lifecycle status — 'watched' set on the title screen
                    // transitions this too. Functional + diff-guarded so we
                    // never clobber a concurrent optimistic change and only
                    // re-render when it actually differs.
                    setRec((prev) =>
                        prev &&
                        typeof recRow.status === 'string' &&
                        prev.status !== recRow.status
                            ? { ...prev, status: recRow.status }
                            : prev,
                    );
                } catch (err) {
                    // Non-fatal: a failed resync just leaves the prior state.
                    console.error('rec status resync on focus failed:', err);
                }
            })();
            return () => {
                active = false;
            };
        }, [recId]),
    );

    // Live thread while focused: any insert/update/delete on THIS rec's
    // comments, reactions, or comment-reactions triggers a silent load()
    // refetch (own writes included — the reconcile is a no-op visually).
    // Each binding gets its own channel (see the lesson in
    // use-thread-realtime). Unlike the chat screen, the reactions binding is
    // live UI here — the rec keeps its reaction picker/incoming row.
    // Comment-reactions filter on the denormalized recommendation_id
    // (20260710150000).
    useThreadRealtime({
        topic: `rec:${recId}`,
        bindings: recId
            ? [
                  {
                      table: 'recommendation_comments',
                      filter: `recommendation_id=eq.${recId}`,
                  },
                  {
                      table: 'recommendation_reactions',
                      filter: `recommendation_id=eq.${recId}`,
                  },
                  {
                      table: 'recommendation_comment_reactions',
                      filter: `recommendation_id=eq.${recId}`,
                  },
              ]
            : [],
        onEvent: load,
        enabled: !!recId,
    });

    // Recompute near-bottom whenever any of its three inputs move. "Near" =
    // within one viewport of the end (same threshold as the chat screen).
    function updateNearBottom() {
        nearBottomRef.current =
            scrollOffsetRef.current + layoutHeightRef.current >=
            contentHeightRef.current - layoutHeightRef.current;
        if (nearBottomRef.current) setShowNewMessagePill(false);
    }

    function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
        const { contentOffset, layoutMeasurement, contentSize } =
            e.nativeEvent;
        scrollOffsetRef.current = contentOffset.y;
        layoutHeightRef.current = layoutMeasurement.height;
        contentHeightRef.current = contentSize.height;
        updateNearBottom();
    }

    function handleContentSizeChange(_w: number, h: number) {
        contentHeightRef.current = h;
        updateNearBottom();
    }

    function handleScrollLayout(e: LayoutChangeEvent) {
        layoutHeightRef.current = e.nativeEvent.layout.height;
        updateNearBottom();
    }

    // Auto-scroll when NEW comments land via a load() refetch (realtime,
    // focus resync, sheet submit): follow with the deferred animated
    // scrollToEnd while at/near the bottom; up at the rec/hero, hold
    // position and show the "New comment ↓" pill — but only for the OTHER
    // party's comments (own appends, e.g. a decline note, manage their own
    // UX). Deliberately NO arrival behavior: on first load (count 0 → N)
    // only the counter is recorded — this screen opens on the rec itself.
    useEffect(() => {
        const prev = prevCommentCountRef.current;
        prevCommentCountRef.current = comments.length;
        if (comments.length <= prev) return;
        if (prev === 0) return;
        const newest = comments[comments.length - 1];
        const isOwn = !!myUserId && newest?.userId === myUserId;
        if (!nearBottomRef.current) {
            if (!isOwn) setShowNewMessagePill(true);
            return;
        }
        setTimeout(() => {
            scrollRef.current?.scrollToEnd({ animated: true });
        }, 50);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on
        // comment-list changes only; myUserId is stable after load.
    }, [comments]);

    const myReaction: ReactionEmoji | null = myUserId
        ? reactions.find((r) => r.userId === myUserId)?.emoji ?? null
        : null;
    const otherReaction =
        myUserId !== null
            ? reactions.find((r) => r.userId !== myUserId) ?? null
            : null;
    const otherReactionProfile: PartyProfile | null = (() => {
        if (!otherReaction || !rec) return null;
        if (otherReaction.userId === rec.fromUserId) return sender;
        if (otherReaction.userId === rec.toUserId) return recipient;
        return null;
    })();
    // Only the recipient can write a reaction (RLS in
    // 20260607120000_restrict_rec_reactions_writes_to_recipient enforces
    // the same rule server-side). The sender still sees the full row +
    // the recipient's caption underneath, but the picker cells are inert.
    const isRecipient = !!myUserId && !!rec && myUserId === rec.toUserId;

    // Review-prompt trigger A: the user has actually VIEWED a rec sent to
    // them. Fires once isRecipient flips true after load. maybeRequestReview
    // re-evaluates BOTH trigger conditions itself and self-limits to once
    // ever — fire-and-forget, never gates this screen.
    useEffect(() => {
        if (isRecipient) void maybeRequestReview();
    }, [isRecipient]);

    // Persist the last-seen incoming-reaction identity AFTER render, so the
    // next visit renders it static (the pop is one-time per new reaction).
    // Keyed on otherReaction's ref: it changes on load (fresh objects) but
    // survives the viewer's own optimistic taps (filter preserves the other
    // party's object ref), so own taps neither re-pop nor rewrite the marker.
    useEffect(() => {
        if (!otherReaction) return;
        void AsyncStorage.setItem(
            `reactionSeen:${recId}`,
            reactionIdentity(otherReaction),
        );
    }, [otherReaction, recId]);

    // Track keyboard visibility so the composer can drop its bottom
    // safe-area inset while typing (the keyboard covers the home-indicator
    // area; keeping the inset leaves a white gap above the keyboard).
    // willShow/Hide on iOS for in-step animation; did* on Android.
    //
    // On show we ALSO scroll the thread to the end so the latest message
    // stays visible right above the composer instead of being clipped behind
    // the shrunk scroll area (the composer is pinned outside the ScrollView,
    // so the KeyboardAvoidingView shrinks the list from the bottom without
    // re-scrolling). keyboardWillShow on iOS animates the scroll in step with
    // the keyboard; keyboardDidShow on Android fires once the frame is known.
    // Same scrollRef/scrollToEnd mechanism as handlePostComment.
    useEffect(() => {
        const showEvt =
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvt =
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvt, () => {
            setKeyboardOpen(true);
            scrollRef.current?.scrollToEnd({ animated: true });
            // The KeyboardAvoidingView shrinks the scroll area DURING the
            // keyboard animation, so the immediate scroll above targets the
            // pre-shrink end. Re-scroll once the animation + layout settle
            // (~300ms covers both platforms) to correct the target. scrollRef
            // is null-safe if the screen unmounts before it fires.
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

    // Decline ("Not for me"). Single immediate write — the user stays on
    // the rec, which re-renders to the "you passed on this" state with an
    // inline un-decline. A noted decline:
    //   - sets status='dismissed' + dismiss_reason=<note>: the null→non-null
    //     transition fires notify_recommendation_declined → the sender's one
    //     "passed on" notification; AND
    //   - posts the note as a real comment (is_decline_note=true) so it
    //     shows in the thread for both parties. The flag stops the
    //     comment-INSERT trigger from also firing rec_commented (no
    //     double-notify), and the comment persists through un-decline.
    // A silent decline (no note) sets dismiss_reason=null — no notification,
    // no comment.
    async function handleConfirmDecline(note: string) {
        if (!rec || declineBusy || !myUserId) return;
        setDeclineBusy(true);
        setShowDeclineSheet(false);
        const previousStatus = rec.status;
        const recId = rec.id;
        const hasNote = note.length > 0;
        // Optimistic flip so the action area switches to the passed state.
        setRec((prev) => (prev ? { ...prev, status: 'dismissed' } : prev));
        try {
            const { error: declineErr } = await supabase
                .from('recommendations')
                .update({
                    status: 'dismissed',
                    dismiss_reason: hasNote ? note : null,
                })
                .eq('id', recId);
            if (declineErr) throw declineErr;

            if (hasNote) {
                // Post the note as a comment in the thread. is_decline_note
                // suppresses the duplicate rec_commented notification (the
                // rec_declined "passed on" notification above is the single
                // notification). Optimistic append on success.
                const { data: inserted, error: commentErr } = await supabase
                    .from('recommendation_comments')
                    .insert({
                        recommendation_id: recId,
                        user_id: myUserId,
                        body: note,
                        is_decline_note: true,
                    })
                    .select('id, created_at')
                    .single();
                if (commentErr) {
                    // Non-fatal: the decline itself stuck. Log; the note
                    // still lives in dismiss_reason + the sender's
                    // notification.
                    console.error('decline note comment failed:', commentErr);
                } else {
                    const myProfile: PartyProfile | null =
                        rec.toUserId === myUserId
                            ? recipient
                            : rec.fromUserId === myUserId
                              ? sender
                              : null;
                    setComments((prev) => [
                        ...prev,
                        {
                            id: inserted.id,
                            userId: myUserId,
                            author: myProfile,
                            body: note,
                            createdAt: inserted.created_at,
                            fromWatched: false,
                        },
                    ]);
                }
            }
        } catch (err) {
            // Revert the optimistic flip and surface the error.
            setRec((prev) =>
                prev ? { ...prev, status: previousStatus } : prev,
            );
            console.error('decline failed:', err);
            Alert.alert('Could not decline', 'Please try again.');
        } finally {
            setDeclineBusy(false);
        }
    }

    // Un-decline ("Changed my mind"): back to 'pending', clearing
    // dismiss_reason (the CHECK rejects a reason on a non-dismissed row).
    // The decline-note comment is intentionally left in the thread — it was
    // a real message. The action area re-renders to Save / "Not for me".
    async function handleUndoDecline() {
        if (!rec || declineBusy) return;
        setDeclineBusy(true);
        const previousStatus = rec.status;
        setRec((prev) => (prev ? { ...prev, status: 'pending' } : prev));
        try {
            const { error: undoErr } = await supabase
                .from('recommendations')
                .update({ status: 'pending', dismiss_reason: null })
                .eq('id', rec.id);
            if (undoErr) throw undoErr;
        } catch (err) {
            // Re-flip to dismissed if the undo write failed.
            setRec((prev) =>
                prev ? { ...prev, status: previousStatus } : prev,
            );
            console.error('undo decline failed:', err);
            Alert.alert('Could not undo', 'Please try again.');
        } finally {
            setDeclineBusy(false);
        }
    }

    // Opens the rating sheet only once a 'watched' pick has both succeeded and
    // the action sheet has fully dismissed (see the refs above). Idempotent —
    // called from whichever of the two finishes last; clears the pending flag
    // so it fires exactly once.
    function maybeOpenRatingSheet() {
        if (pendingRatingRef.current && actionSheetClosedRef.current) {
            pendingRatingRef.current = false;
            setShowRatingSheet(true);
        }
    }

    // Set the recipient's library status from the action sheet. Mirrors
    // the title page: upsert the items row (nulling rating/watched_at off
    // 'watched', stamping watched_at on it), stamp the shared titles
    // catalogue via ensureTitle (the rec-send path doesn't), and for
    // 'watched' open the rating sheet (deferred until the action sheet has
    // fully dismissed — see maybeOpenRatingSheet; applyWatchedRating then
    // transitions this rec → watched in handleRate). Watchlist/watching leave
    // the rec untouched (stays pending in the inbox). Optimistic; reverts on
    // error.
    async function handlePickStatus(status: ItemStatus) {
        setShowActionSheet(false);
        // The sheet is now dismissing (not yet closed); onClosed will flip
        // this true when its close animation finishes.
        actionSheetClosedRef.current = false;
        if (!rec || statusBusy || status === currentStatus) return;
        setStatusBusy(true);
        const prevStatus = currentStatus;
        const prevRating = currentRating;
        const isWatched = status === 'watched';
        setCurrentStatus(status);
        if (!isWatched) setCurrentRating(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error: upsertError } = await supabase.from('items').upsert(
                {
                    user_id: userId,
                    tmdb_id: rec.tmdbId,
                    media_type: rec.mediaType,
                    status,
                    // rating MUST be null off 'watched' (CHECK); undefined
                    // on watched preserves any existing DB rating.
                    rating: isWatched ? undefined : null,
                    watched_at: isWatched ? new Date().toISOString() : null,
                },
                { onConflict: 'user_id,tmdb_id,media_type' },
            );
            if (upsertError) throw upsertError;

            // Stamp the catalogue so the title renders in their library
            // (send_recommendation doesn't create the titles row).
            if (titleMeta) {
                void ensureTitle({
                    tmdbId: rec.tmdbId,
                    mediaType: rec.mediaType,
                    title: titleMeta.title,
                    posterPath: titleMeta.posterPath,
                    backdropPath: titleMeta.backdropPath,
                    releaseDate: titleMeta.releaseDate,
                    originalLanguage: titleMeta.originalLanguage,
                    genreIds: titleMeta.genreIds,
                });
            }

            // Upsert succeeded. Don't open the rating sheet inline — the
            // action sheet may still be dismissing. Record the intent and try
            // to open; if the sheet hasn't finished closing yet, onClosed will.
            if (isWatched) {
                pendingRatingRef.current = true;
                maybeOpenRatingSheet();
            }
        } catch (err) {
            // Upsert failed — abandon any pending rating open so a late
            // onClosed doesn't surface the rating sheet over a reverted state.
            pendingRatingRef.current = false;
            setCurrentStatus(prevStatus);
            setCurrentRating(prevRating);
            console.error('set status failed:', err);
            Alert.alert('Could not update', 'Please try again.');
        } finally {
            setStatusBusy(false);
        }
    }

    // The RatingSheet owns persistence (rating + rec transitions + comment/
    // note/visibility). Close, then reload the whole screen so the new comment,
    // the rec's now-watched lifecycle status (Decline option drops), and the
    // library status/rating all appear without navigating away and back — the
    // sheet is a modal on this screen, so nothing else triggers a refresh.
    // Unconditional: a note-only submit and Skip also change DB state (comment
    // posted / rec marked watched), and load() never re-sets `loading`, so this
    // silently re-fetches with no spinner flash. setCurrentRating stays for
    // instant star feedback while load() is in flight.
    function handleRate(rating: number | null) {
        setShowRatingSheet(false);
        if (rating !== null) setCurrentRating(rating);
        void load();
    }

    async function handleReactionTap(emoji: ReactionEmoji) {
        if (!myUserId || !rec || reactionBusy || !isRecipient) return;
        const removing = myReaction === emoji;
        // Optimistic: flip my reaction in local state FIRST so the picker
        // cell + its pop land instantly, not after the DB round-trip. Snapshot
        // the prior list to roll back on failure.
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
                // Tap the active emoji to remove.
                const { error: delErr } = await supabase
                    .from('recommendation_reactions')
                    .delete()
                    .eq('recommendation_id', rec.id)
                    .eq('user_id', myUserId);
                if (delErr) throw delErr;
            } else {
                // Upsert — INSERT if no row yet, UPDATE if already
                // reacted with a different emoji. The PK on (rec,
                // user) makes onConflict='recommendation_id,user_id'
                // the right merge target.
                const { error: upsertErr } = await supabase
                    .from('recommendation_reactions')
                    .upsert(
                        {
                            recommendation_id: rec.id,
                            user_id: myUserId,
                            emoji,
                        },
                        { onConflict: 'recommendation_id,user_id' },
                    );
                if (upsertErr) throw upsertErr;
            }
        } catch (err) {
            // Roll back the optimistic change.
            setReactions(previous);
            console.error('reaction update failed:', err);
            Alert.alert(
                "Couldn't react",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setReactionBusy(false);
        }
    }

    // Mirrors handleReactionTap one layer down. Same delete-on-active /
    // upsert-on-change/add semantics. Per-comment busy flag so the rest
    // of the thread stays interactive while one comment's write is in
    // flight. Server-side RLS gates this on is_party_to_comment, so a
    // non-party tap would surface here as a write error — we don't
    // pre-gate on a sender flag the way the rec-level picker does,
    // because both parties can react to comments.
    async function handleCommentReactionTap(
        commentId: string,
        emoji: ReactionEmoji,
    ) {
        if (!myUserId || !rec || commentReactionBusy) return;
        setCommentReactionBusy(commentId);
        try {
            const list = commentReactions.get(commentId) ?? [];
            const myCurrent =
                list.find((r) => r.userId === myUserId)?.emoji ?? null;
            if (myCurrent === emoji) {
                const { error: delErr } = await supabase
                    .from('recommendation_comment_reactions')
                    .delete()
                    .eq('comment_id', commentId)
                    .eq('user_id', myUserId);
                if (delErr) throw delErr;
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
                const { error: upsertErr } = await supabase
                    .from('recommendation_comment_reactions')
                    .upsert(
                        // reason: recommendation_id (denormalized thread id
                        // for the realtime filter, 20260710150000) isn't in
                        // the generated types yet — cast the row, same
                        // pattern as items.note.
                        {
                            comment_id: commentId,
                            user_id: myUserId,
                            emoji,
                            recommendation_id: rec.id,
                        } as never,
                        { onConflict: 'comment_id,user_id' },
                    );
                if (upsertErr) throw upsertErr;
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
            console.error('comment reaction update failed:', err);
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
        if (!body || !myUserId || !rec || composerBusy) return;
        if (body.length > COMMENT_MAX_CHARS) return;
        setComposerBusy(true);
        try {
            const inserted = await postRecComment(rec.id, myUserId, body);
            // Optimistic append using the row id + created_at the DB
            // just returned — saves a refetch and keeps the scroll
            // position rooted at the new comment.
            const myProfile: PartyProfile | null =
                rec.fromUserId === myUserId
                    ? sender
                    : rec.toUserId === myUserId
                      ? recipient
                      : null;
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
            // Defer the scroll to the end of the frame so the new
            // row has actually laid out first.
            setTimeout(() => {
                scrollRef.current?.scrollToEnd({ animated: true });
            }, 50);
        } catch (err) {
            console.error('post comment failed:', err);
            Alert.alert(
                "Couldn't post comment",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setComposerBusy(false);
        }
    }

    // Composer focus fallback for the focus-without-keyboard-event case
    // (e.g. a hardware keyboard, where no keyboardWillShow/DidShow fires):
    // still pull the latest message above the input on focus.
    function handleComposerFocus() {
        scrollRef.current?.scrollToEnd({
            animated: true,
        });
        // Correct the target after the keyboard/KAV resize settles (see the
        // keyboard-show listener) — the immediate scroll lands on the
        // pre-shrink end.
        setTimeout(() => {
            scrollRef.current?.scrollToEnd({
                animated: true,
            });
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
                        const { error: delErr } = await supabase
                            .from('recommendation_comments')
                            .delete()
                            .eq('id', commentId);
                        if (delErr) throw delErr;
                        setComments((prev) =>
                            prev.filter((c) => c.id !== commentId),
                        );
                    } catch (err) {
                        console.error('delete comment failed:', err);
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
                // Now a full-screen card (not a modal sheet), the rec view
                // covers the status bar / notch, so the X must clear it via
                // the top safe-area inset. insets.top is 0 on non-notch
                // devices, leaving just the spacing.base gap.
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
    if (error || !rec || !titleMeta) {
        // Friendly fallback for every failure. Retryable (connection / TMDB)
        // → "Try again" re-fires the load; terminal states (invalid / gone /
        // no access — canRetry=false) show their specific message, no button.
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                {closeButton}
                <LoadError
                    title={canRetry ? "Couldn't load this rec" : 'Rec unavailable'}
                    message={
                        canRetry
                            ? 'Check your connection and try again.'
                            : error ?? 'This rec isn’t available.'
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

    // Attribution copy for the image overlay, mirroring the home hero:
    // recommender's first name in the accent + verb + timeago. When the
    // current user is the sender it flips to "You recommended" so the
    // screen reads naturally regardless of which side opened it.
    const isMeSender = myUserId === rec.fromUserId;
    const senderName = isMeSender
        ? 'You'
        : sender?.displayName ?? 'Former user';
    const pillName = isMeSender ? 'You' : senderName.split(/\s+/)[0] || senderName;
    const pillVerb = isMeSender ? 'recommended' : 'recommends';

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {closeButton}
            <KeyboardAvoidingView
                style={styles.flex}
                behavior="padding"
                // The rec view is a full-screen card (was a modal sheet),
                // so this KeyboardAvoidingView starts at the very top of the
                // screen — offset 0. The old 40pt offset (tuned for the
                // modal's ~30pt top inset) over-padded once we switched to
                // 'card': it pushed the composer ~40pt above the keyboard
                // (the gap) and over-shrank the scroll area, collapsing the
                // visible content.
                keyboardVerticalOffset={0}
            >
                {/* Relative wrapper so the "New comment ↓" pill can float at
                    the scroll area's bottom edge, above the composer. */}
                <View style={styles.flex}>
                <ScrollView
                    ref={scrollRef}
                    // flex: 1 so the scroll area fills the space above the
                    // composer — without it a short rec leaves the
                    // ScrollView content-height and the composer floats up
                    // with empty space below it instead of bottom-anchoring.
                    style={styles.flex}
                    onScroll={handleScroll}
                    // Proximity tracking only needs coarse updates.
                    scrollEventThrottle={100}
                    onContentSizeChange={handleContentSizeChange}
                    onLayout={handleScrollLayout}
                    contentContainerStyle={[
                        styles.scrollContent,
                        { paddingBottom: insets.bottom + spacing.base },
                    ]}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* Immersive backdrop header (the hero) — the title's
                        wide TMDB backdrop (same image the home hero uses,
                        via the shared imageUrl util), with the recommender
                        attribution overlaid bottom-left. Fallback when
                        there's no backdrop: a plum block, so the header
                        always looks intentional. */}
                    <View style={styles.headerImage}>
                        {titleMeta.backdropPath ? (
                            <Image
                                source={{
                                    uri: imageUrl(titleMeta.backdropPath, 'w780'),
                                }}
                                style={StyleSheet.absoluteFill}
                                contentFit="cover"
                                transition={200}
                            />
                        ) : (
                            <View
                                style={[
                                    StyleSheet.absoluteFill,
                                    { backgroundColor: palette.accentWash },
                                ]}
                            />
                        )}
                        {/* Image→page fade, bottom-anchored: a pure alpha
                            ramp of the bg colour (transparent bg → bg),
                            so it melts straight into the page with no grey
                            or pale band and ends exactly on palette.bg. */}
                        <LinearGradient
                            colors={[palette.bgTransparent, palette.bg]}
                            locations={[0.55, 1]}
                            style={StyleSheet.absoluteFill}
                        />
                        {/* Very subtle darkening behind the text band — just
                            enough to take the edge off a bright backdrop. The
                            real legibility work is done by the per-glyph text
                            shadow (overlayShadow), which hugs the letters and
                            never reads as an overlay band. Kept light (0.28)
                            and peaked behind the text (~0.72), easing clear
                            well before the seam (0.92 → 1.0) so there's no
                            visible patch or grey band at the image→page edge. */}
                        <LinearGradient
                            colors={[
                                'transparent',
                                'rgba(0, 0, 0, 0.28)',
                                'transparent',
                            ]}
                            locations={[0.35, 0.72, 0.92]}
                            style={StyleSheet.absoluteFill}
                            pointerEvents="none"
                        />
                        {/* Title block, bottom-left — the whole block is
                            the tappable bridge to the title page. Poster +
                            title/meta + a quiet chevron affordance. Lifted
                            off the bottom edge so it sits in the scrim's
                            dark band with breathing room below. */}
                        <Pressable
                            onPress={() =>
                                // push: this rec view is now a CARD (see
                                // _layout.tsx), so pushing the title presents
                                // it as a first-level fullScreenModal over the
                                // rec card — a genuine full-screen page with
                                // ALL sections, and back returns here to the
                                // conversation. (Same structure as opening the
                                // title from inbox.) fromRec surfaces the rec
                                // context on the title's attribution card.
                                router.push(
                                    `/title/${rec.mediaType}/${rec.tmdbId}?fromRec=${rec.id}`,
                                )
                            }
                            accessibilityRole="link"
                            accessibilityLabel={`View details for ${titleMeta.title}`}
                            style={({ pressed }) => [
                                styles.identityOverlay,
                                { opacity: pressed ? 0.7 : 1 },
                            ]}
                        >
                            {titleMeta.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(titleMeta.posterPath, 'w185'),
                                    }}
                                    style={styles.identityPoster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.identityPoster,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <View style={styles.identityTitleText}>
                                <Text
                                    style={[
                                        styles.overlayTitle,
                                        styles.overlayShadow,
                                        { color: '#FFFFFF' },
                                    ]}
                                    numberOfLines={2}
                                >
                                    {titleMeta.title}
                                </Text>
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.overlayShadow,
                                        { color: 'rgba(255,255,255,0.85)' },
                                    ]}
                                >
                                    {[
                                        titleMeta.year,
                                        rec.mediaType === 'movie'
                                            ? 'Movie'
                                            : 'TV',
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                </Text>
                                {/* Labelled, obvious tap affordance. */}
                                <View
                                    style={[
                                        styles.overlayCta,
                                        { backgroundColor: palette.surface },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            typography.caption,
                                            styles.overlayCtaText,
                                            { color: palette.text },
                                        ]}
                                    >
                                        View details
                                    </Text>
                                    <ChevronRight
                                        color={palette.text}
                                        size={16}
                                        strokeWidth={ICON_STROKE_WIDTH}
                                    />
                                </View>
                            </View>
                        </Pressable>
                    </View>

                    {/* Padded body. */}
                    <View style={styles.bodyPad}>

                    {/* Recommender line — small avatar + "{name} recommends
                        · {when}", directly above the note so the note reads
                        as that person's words. */}
                    <View style={styles.recLine}>
                        <UserLink
                            userId={rec.fromUserId}
                            disabled={isMeSender}
                            hitSlop={8}
                            accessibilityLabel={`View ${senderName}'s profile`}
                        >
                            <Avatar
                                avatarUrl={sender?.avatarUrl ?? null}
                                displayName={senderName}
                                seedId={rec.fromUserId ?? sender?.userId ?? rec.id}
                                size={REC_LINE_AVATAR_SIZE}
                            />
                        </UserLink>
                        <Text
                            style={[
                                typography.caption,
                                { color: palette.textMuted },
                            ]}
                            numberOfLines={1}
                        >
                            <Text
                                style={[
                                    typography.caption,
                                    styles.recommenderName,
                                    { color: palette.accent },
                                ]}
                                onPress={
                                    isMeSender
                                        ? undefined
                                        : () =>
                                              goToProfile({
                                                  userId: rec.fromUserId,
                                              })
                                }
                            >
                                {pillName}
                            </Text>{' '}
                            {pillVerb} · {relativeTimestamp(rec.sentAt)}
                        </Text>
                        {/* Visible Report affordance (App Store 1.2) — primary
                            path; the note also long-presses. Recipient only
                            (can't report your own note), with a sender to
                            attribute it to. */}
                        {!isMeSender && rec.fromUserId ? (
                            <Pressable
                                onPress={() =>
                                    promptReport({
                                        type: 'recommendation',
                                        id: rec.id,
                                        reportedUserId: rec.fromUserId,
                                        title: 'Report recommendation',
                                    })
                                }
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                accessibilityLabel="Report recommendation"
                                style={({ pressed }) => [
                                    styles.recReportButton,
                                    pressed && { opacity: 0.5 },
                                ]}
                            >
                                <MoreHorizontal
                                    color={palette.textMuted}
                                    size={18}
                                    strokeWidth={ICON_STROKE_WIDTH}
                                />
                            </Pressable>
                        ) : null}
                    </View>

                    {/* The note — the hero of the screen. Large quote
                        treatment, full text (no truncation), wraps for
                        long notes. Long-press to Report the recommendation
                        (App Store 1.2) — only for the recipient (you can't
                        report your own note), and only when there's a sender
                        to attribute it to. */}
                    {rec.note ? (
                        !isMeSender && rec.fromUserId ? (
                            <Pressable
                                onLongPress={() =>
                                    promptReport({
                                        type: 'recommendation',
                                        id: rec.id,
                                        reportedUserId: rec.fromUserId,
                                        title: 'Report recommendation',
                                    })
                                }
                                style={({ pressed }) => [
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.noteHero,
                                        { color: palette.text },
                                    ]}
                                >
                                    “{rec.note}”
                                </Text>
                            </Pressable>
                        ) : (
                            <Text
                                style={[styles.noteHero, { color: palette.text }]}
                            >
                                “{rec.note}”
                            </Text>
                        )
                    ) : null}

                    {/* Reactions — curated emoji picker (no label). Recipient
                        only: reacting is a recipient action, so the sender
                        doesn't see the picker (they still see the recipient's
                        reaction read-only below). */}
                    {isRecipient ? (
                        <ThreadReactionPicker
                            selected={myReaction}
                            busy={reactionBusy}
                            onTap={handleReactionTap}
                        />
                    ) : null}
                    {otherReaction ? (
                        <ThreadIncomingReaction
                            reaction={otherReaction}
                            profile={otherReactionProfile}
                            animate={shouldAnimateReaction}
                        />
                    ) : null}

                    {/* Action area — RECIPIENT ONLY (Save / decline are
                        recipient actions; the sender saves to their own
                        library via "View details" → title page). Recipient
                        who has passed → a "you passed on this" marker +
                        "Changed my mind" (un-decline). Otherwise: Save =
                        primary (filled accent) → status sheet; "Not for me"
                        = secondary (muted) → decline, on a pending rec. */}
                    {!isRecipient ? null : rec.status === 'dismissed' ? (
                        <View style={styles.actionArea}>
                            <View style={styles.passedMarker}>
                                <XCircle
                                    color={palette.textMuted}
                                    size={16}
                                    strokeWidth={ICON_STROKE_WIDTH}
                                />
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    You passed on this
                                </Text>
                            </View>
                            <Pressable
                                onPress={handleUndoDecline}
                                disabled={declineBusy}
                                accessibilityRole="button"
                                accessibilityLabel="Changed my mind"
                                style={({ pressed }) => [
                                    styles.saveButton,
                                    {
                                        backgroundColor: palette.accent,
                                        opacity:
                                            pressed || declineBusy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textInverse },
                                    ]}
                                >
                                    Changed my mind
                                </Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View style={styles.actionArea}>
                            <Pressable
                                onPress={() => setShowActionSheet(true)}
                                disabled={statusBusy}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    currentStatus
                                        ? `Saved: ${formatLibraryBadge(currentStatus, currentRating)}. Tap to change.`
                                        : 'Save to your library'
                                }
                                style={({ pressed }) => [
                                    styles.saveButton,
                                    {
                                        backgroundColor: palette.accent,
                                        opacity:
                                            pressed || statusBusy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textInverse },
                                    ]}
                                >
                                    {currentStatus
                                        ? formatLibraryBadge(
                                              currentStatus,
                                              currentRating,
                                          )
                                        : 'Save'}
                                </Text>
                            </Pressable>

                            {isRecipient && rec.status === 'pending' ? (
                                <Pressable
                                    onPress={() => setShowDeclineSheet(true)}
                                    disabled={declineBusy}
                                    accessibilityRole="button"
                                    accessibilityLabel="Not for me"
                                    style={({ pressed }) => [
                                        styles.notForMeButton,
                                        {
                                            opacity:
                                                pressed || declineBusy
                                                    ? 0.6
                                                    : 1,
                                        },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            typography.bodyEmphasis,
                                            { color: palette.textMuted },
                                        ]}
                                    >
                                        Not for me
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    )}

                    {/* Comments — no label; the composer placeholder
                        carries the empty state. An empty list renders
                        nothing. */}
                    <ThreadCommentList
                        comments={comments}
                        myUserId={myUserId}
                        commentReactions={commentReactions}
                        onLongPressComment={setCommentMenuFor}
                    />
                    </View>
                </ScrollView>

                {/* Floating "New comment ↓" — shown when the other party's
                    comment landed while the user was up at the rec/hero. Tap
                    scrolls to the end; reaching the bottom yourself also
                    clears it (see updateNearBottom). Same accent pill as the
                    chat screen's. */}
                {showNewMessagePill ? (
                    <Pressable
                        onPress={() => {
                            setShowNewMessagePill(false);
                            scrollRef.current?.scrollToEnd({ animated: true });
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Scroll to newest comment"
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
                            New comment ↓
                        </Text>
                    </Pressable>
                ) : null}
                </View>

                {/* Composer pinned to the bottom of the keyboard
                    avoidance container. The screen owns the keyboard
                    listeners (they also drive the thread scroll) and passes
                    keyboardOpen down for the bar's bottom padding. */}
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
                    avatarUrl={
                        (isMeSender ? sender : recipient)?.avatarUrl ?? null
                    }
                    avatarDisplayName={
                        (isMeSender ? sender : recipient)?.displayName ?? '?'
                    }
                    avatarSeedId={myUserId ?? rec.id}
                />
            </KeyboardAvoidingView>
            {/* Long-press popover for comment reactions + per-comment
                actions — see ThreadCommentMenu. The menu dismisses itself
                before invoking each handler; delete / report flows stay
                here on the screen. */}
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

            {/* Save sheet — Watchlist / Watching / Watched (status only;
                "Not for me" is its own button). */}
            <RecActionSheet
                visible={showActionSheet}
                currentStatus={currentStatus}
                busy={statusBusy}
                onClose={() => setShowActionSheet(false)}
                onPickStatus={handlePickStatus}
                onClosed={() => {
                    // Action sheet fully unmounted — safe to present the
                    // rating sheet now. Opens it if the 'watched' upsert has
                    // already succeeded; otherwise the upsert's own call wins.
                    actionSheetClosedRef.current = true;
                    maybeOpenRatingSheet();
                }}
            />

            {/* Rating sheet — opens after a 'watched' pick. */}
            <RatingSheet
                visible={showRatingSheet}
                busy={false}
                initialRating={currentRating}
                tmdbId={rec.tmdbId}
                mediaType={rec.mediaType}
                onSubmit={handleRate}
            />

            {/* Decline sheet — optional note + Confirm. */}
            <DeclineSheet
                visible={showDeclineSheet}
                senderName={pillName === 'You' ? '' : pillName}
                busy={declineBusy}
                onCancel={() => setShowDeclineSheet(false)}
                onConfirm={handleConfirmDecline}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    // Save (filled) + "Not for me" (muted) actions between the reactions
    // and the composer. The note hero stays the largest element above.
    actionArea: {
        marginTop: spacing.lg,
        gap: spacing.xs,
    },
    saveButton: {
        // Primary, filled accent — the prominent action.
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    notForMeButton: {
        // Secondary, understated — muted text, no fill/border, so it's
        // clearly lighter than Save but still visible.
        alignSelf: 'center',
        paddingVertical: spacing.sm,
    },
    // "You passed on this" marker above the "Changed my mind" un-decline,
    // shown in the dismissed action area. Centred muted row (X + label).
    passedMarker: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.sm,
    },
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
        // No top/horizontal padding here — the backdrop header is
        // full-bleed at the very top; text content gets its inset from
        // bodyPad. paddingBottom is applied inline (safe-area inset).
    },
    headerImage: {
        width: '100%',
        height: HEADER_HEIGHT,
    },
    bodyPad: {
        // Below the hero image. No pull-up — the recommender is overlaid
        // on the image now, so the body leads cleanly with the title
        // block on the page bg.
        paddingHorizontal: spacing.base,
    },
    recommenderName: {
        // Bold Geist on the name chunk in the attribution line (mirrors
        // the home hero's light-plum name treatment).
        fontFamily: fontFamily.bold,
        fontWeight: '700',
    },
    identityOverlay: {
        // Tappable title block, bottom-left: poster + title/meta/CTA.
        // Lifted off the bottom edge (bottom: xl) for breathing room —
        // nudged a touch lower than before.
        position: 'absolute',
        left: spacing.base,
        right: spacing.base,
        bottom: spacing.xl,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    identityPoster: {
        // Larger poster thumbnail on the overlay.
        width: 80,
        height: 120,
        borderRadius: radius.sm,
    },
    identityTitleText: {
        flex: 1,
        gap: spacing.xs,
    },
    overlayShadow: {
        // Strong, tight dark halo hugging each glyph — this (not a heavy
        // scrim) is what keeps the white title + muted year legible over
        // ANY backdrop, including bright/busy ones, without any visible
        // overlay band. High opacity + a smaller radius reads as a crisp
        // outline rather than a soft cloud.
        textShadowColor: 'rgba(0, 0, 0, 0.9)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 5,
    },
    overlayCta: {
        // "View details ›" as a solid chip (not bare text on the photo) so
        // it's clearly legible + reads as a real tappable control.
        // Content-sized, left-aligned. backgroundColor applied inline.
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: spacing.xs,
        marginTop: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    overlayCtaText: {
        fontFamily: fontFamily.medium,
        fontWeight: '500',
    },
    overlayTitle: {
        // Larger than typography.heading — the title is the headline of
        // the overlay.
        fontFamily: fontFamily.bold,
        fontWeight: '700',
        fontSize: 26,
        lineHeight: 30,
    },
    recLine: {
        // Recommender attribution row above the note: small avatar + the
        // "{name} recommends · {when}" line. Modest gap above (below the
        // image) so the title block and recommender read as one connected
        // unit; tight tie to the note below.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: spacing.md,
    },
    recReportButton: {
        // Trailing "⋯" on the recommender line — pushed to the row's far
        // edge, quiet (textMuted) so it doesn't compete with the note.
        marginLeft: 'auto',
        padding: spacing.xs,
    },
    newMessagePill: {
        // Floating over the scroll area's bottom edge, self-centered.
        // Full-radius accent pill (fill set inline) — same as the chat
        // screen's new-message pill.
        position: 'absolute',
        bottom: spacing.md,
        alignSelf: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    noteHero: {
        // The hero note — large pull-quote. Geist regular at a generous
        // size + line height, italic to read as a quote. No numberOfLines
        // — the full note wraps, however long (~500-char composer cap).
        // Tight marginTop ties it to the recommender line above (his
        // attribution → his words).
        fontFamily: fontFamily.default,
        fontWeight: '400',
        fontSize: 25,
        lineHeight: 34,
        fontStyle: 'italic',
        marginTop: spacing.sm,
    },
});
