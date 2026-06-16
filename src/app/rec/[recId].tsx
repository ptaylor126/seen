import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowRight, Send, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Locked emoji set — must match the CHECK constraint on
// recommendation_reactions.emoji. Widening is a one-line migration
// PLUS adding the new emoji to this array. Order is the picker order.
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '👀'] as const;
type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

function isReactionEmoji(value: string): value is ReactionEmoji {
    return (REACTION_EMOJIS as readonly string[]).includes(value);
}

const COMMENT_MAX_CHARS = 500;
const POSTER_W = 64;
const POSTER_H = 96;
const AVATAR_SIZE = 32;
const REACTION_PICKER_SIZE = 40;

interface PartyProfile {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
}

interface RecSummary {
    id: string;
    fromUserId: string | null;
    toUserId: string;
    tmdbId: number;
    mediaType: MediaType;
    note: string | null;
    sentAt: string;
}

interface TitleMeta {
    title: string;
    year: string;
    posterPath: string | null;
}

interface ReactionRow {
    userId: string;
    emoji: ReactionEmoji;
}

interface CommentRow {
    id: string;
    userId: string | null;
    author: PartyProfile | null; // null = author was deleted (user_id SET NULL)
    body: string;
    createdAt: string;
}

function relativeTimestamp(iso: string): string {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = diffMs / (1000 * 60);
    const diffHours = diffMinutes / 60;
    const diffDays = diffHours / 24;
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${Math.floor(diffMinutes)}m`;
    if (diffHours < 24) return `${Math.floor(diffHours)}h`;
    if (diffDays < 7) return `${Math.floor(diffDays)}d`;
    return date.toLocaleDateString();
}

export default function RecScreen() {
    const params = useLocalSearchParams<{ recId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    const recId = typeof params.recId === 'string' ? params.recId : '';

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [myUserId, setMyUserId] = useState<string | null>(null);
    const [rec, setRec] = useState<RecSummary | null>(null);
    const [titleMeta, setTitleMeta] = useState<TitleMeta | null>(null);
    const [sender, setSender] = useState<PartyProfile | null>(null);
    const [recipient, setRecipient] = useState<PartyProfile | null>(null);
    const [reactions, setReactions] = useState<ReactionRow[]>([]);
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
    // the user pressed. `anchorY` is from the long-press event's
    // nativeEvent.pageY (screen Y); `isOwn` controls whether the
    // actions menu appears below the emoji row.
    const [commentMenuFor, setCommentMenuFor] = useState<{
        commentId: string;
        anchorY: number;
        isOwn: boolean;
    } | null>(null);
    const [composer, setComposer] = useState('');
    const [composerBusy, setComposerBusy] = useState(false);
    const scrollRef = useRef<ScrollView | null>(null);

    // Single loader for the whole screen — splits into three queries
    // after the rec lookup so the dependent fetches (profiles by id,
    // TMDB title) can run in parallel. Cancellation via `active` so
    // a quick re-mount doesn't race.
    const load = useCallback(async () => {
        if (!recId) {
            setError('Invalid rec');
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
                    'id, from_user_id, to_user_id, tmdb_id, media_type, note, sent_at',
                )
                .eq('id', recId)
                .maybeSingle();
            if (recErr) throw recErr;
            if (!recRow) {
                setError('Rec not found');
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
                setError('You do not have access to this rec');
                setLoading(false);
                return;
            }
            const mediaType =
                recRow.media_type === 'movie' || recRow.media_type === 'tv'
                    ? (recRow.media_type as MediaType)
                    : null;
            if (!mediaType) {
                setError('Rec has invalid media type');
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
            ] = await Promise.all([
                supabase
                    .from('profiles')
                    .select('id, display_name, avatar_url')
                    .in('id', partyIds),
                supabase
                    .from('recommendation_reactions')
                    .select('user_id, emoji')
                    .eq('recommendation_id', recId),
                supabase
                    .from('recommendation_comments')
                    .select('id, user_id, body, created_at')
                    .eq('recommendation_id', recId)
                    .order('created_at', { ascending: true }),
                (mediaType === 'movie'
                    ? getMovie(summary.tmdbId)
                    : getTV(summary.tmdbId)
                ).then<TitleMeta>((data) => ({
                    title: 'title' in data ? data.title : data.name,
                    year:
                        'release_date' in data
                            ? data.release_date?.slice(0, 4) ?? ''
                            : data.first_air_date?.slice(0, 4) ?? '',
                    posterPath: data.poster_path,
                })),
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
                    });
                }
            }
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
        } catch (err) {
            console.error('rec detail load failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [recId]);

    useEffect(() => {
        void load();
    }, [load]);

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

    async function handleReactionTap(emoji: ReactionEmoji) {
        if (!myUserId || !rec || reactionBusy || !isRecipient) return;
        setReactionBusy(true);
        try {
            if (myReaction === emoji) {
                // Tap the active emoji to remove.
                const { error: delErr } = await supabase
                    .from('recommendation_reactions')
                    .delete()
                    .eq('recommendation_id', rec.id)
                    .eq('user_id', myUserId);
                if (delErr) throw delErr;
                setReactions((prev) =>
                    prev.filter((r) => r.userId !== myUserId),
                );
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
                setReactions((prev) => {
                    const withoutMine = prev.filter(
                        (r) => r.userId !== myUserId,
                    );
                    return [...withoutMine, { userId: myUserId, emoji }];
                });
            }
        } catch (err) {
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
                        {
                            comment_id: commentId,
                            user_id: myUserId,
                            emoji,
                        },
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
            const { data: inserted, error: insertErr } = await supabase
                .from('recommendation_comments')
                .insert({
                    recommendation_id: rec.id,
                    user_id: myUserId,
                    body,
                })
                .select('id, created_at')
                .single();
            if (insertErr) throw insertErr;
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
                { top: spacing.base, backgroundColor: palette.surface },
            ]}
        >
            <X color={palette.text} size={20} strokeWidth={ICON_STROKE_WIDTH} />
        </Pressable>
    );

    if (loading) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                {closeButton}
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            </View>
        );
    }
    if (error || !rec || !titleMeta) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                {closeButton}
                <View style={styles.fillCenter}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                    >
                        {error ?? 'Rec not available'}
                    </Text>
                </View>
            </View>
        );
    }

    // Compose the rec-context line ("Sender recommended Title"). When
    // the current user is the sender, flip it to "You recommended …"
    // so the screen reads naturally regardless of which side opened it.
    const isMeSender = myUserId === rec.fromUserId;
    const senderName = isMeSender
        ? 'You'
        : sender?.displayName ?? 'Former user';
    const recipientName = rec.toUserId === myUserId
        ? 'you'
        : recipient?.displayName ?? 'them';
    const contextLine = isMeSender
        ? `You recommended this to ${recipientName}`
        : `${senderName} recommended this to you`;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {closeButton}
            <KeyboardAvoidingView
                style={styles.flex}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                // Account for the modal sheet not pinning to the top
                // of the device — iOS modal slides down ~30pt from
                // the status bar. Without this offset the composer
                // sits flush against the keyboard top.
                keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 0}
            >
                <ScrollView
                    ref={scrollRef}
                    contentContainerStyle={[
                        styles.scrollContent,
                        { paddingBottom: insets.bottom + spacing.base },
                    ]}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* Rec header — sender attribution + title summary. */}
                    <View style={styles.header}>
                        <Avatar
                            avatarUrl={
                                isMeSender
                                    ? recipient?.avatarUrl ?? null
                                    : sender?.avatarUrl ?? null
                            }
                            displayName={
                                isMeSender
                                    ? recipient?.displayName ?? '?'
                                    : sender?.displayName ?? '?'
                            }
                            seedId={
                                (isMeSender
                                    ? recipient?.userId
                                    : sender?.userId) ?? rec.id
                            }
                            size={AVATAR_SIZE}
                        />
                        <View style={styles.headerText}>
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.text },
                                ]}
                                numberOfLines={2}
                            >
                                {contextLine}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {relativeTimestamp(rec.sentAt)}
                            </Text>
                        </View>
                    </View>

                    {rec.note ? (
                        <Text
                            style={[
                                typography.body,
                                styles.note,
                                { color: palette.text },
                            ]}
                        >
                            “{rec.note}”
                        </Text>
                    ) : null}

                    {/* Title summary + "View title" bridge. */}
                    <Pressable
                        onPress={() =>
                            router.push(
                                `/title/${rec.mediaType}/${rec.tmdbId}?fromRec=${rec.id}`,
                            )
                        }
                        style={({ pressed }) => [
                            styles.titleCard,
                            {
                                backgroundColor: palette.surfaceAlt,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        {titleMeta.posterPath ? (
                            <Image
                                source={{
                                    uri: imageUrl(titleMeta.posterPath, 'w185'),
                                }}
                                style={styles.poster}
                                contentFit="cover"
                                transition={150}
                            />
                        ) : (
                            <View
                                style={[
                                    styles.poster,
                                    { backgroundColor: palette.surface },
                                ]}
                            />
                        )}
                        <View style={styles.titleText}>
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
                                    rec.mediaType === 'movie' ? 'Movie' : 'TV',
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                            <View style={styles.viewTitleRow}>
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.accent },
                                    ]}
                                >
                                    View title
                                </Text>
                                <ArrowRight
                                    color={palette.accent}
                                    size={14}
                                    strokeWidth={ICON_STROKE_WIDTH}
                                />
                            </View>
                        </View>
                    </Pressable>

                    {/* Reactions section. */}
                    <Text
                        style={[
                            typography.micro,
                            styles.sectionHeading,
                            { color: palette.textMuted },
                        ]}
                    >
                        REACTIONS
                    </Text>
                    <View style={styles.reactionRow}>
                        {REACTION_EMOJIS.map((emoji) => {
                            const isActive = myReaction === emoji;
                            return (
                                <Pressable
                                    key={emoji}
                                    onPress={() => handleReactionTap(emoji)}
                                    disabled={reactionBusy || !isRecipient}
                                    accessibilityRole="button"
                                    accessibilityLabel={`React with ${emoji}`}
                                    accessibilityState={{
                                        selected: isActive,
                                        disabled: !isRecipient,
                                    }}
                                    style={({ pressed }) => [
                                        styles.reactionCell,
                                        {
                                            backgroundColor: isActive
                                                ? palette.accent
                                                : palette.surfaceAlt,
                                            // Read-only for the sender: dim the
                                            // whole picker so the inertness is
                                            // visible, distinct from the active
                                            // accent on the recipient's pick.
                                            opacity: !isRecipient
                                                ? 0.4
                                                : pressed || reactionBusy
                                                    ? 0.6
                                                    : 1,
                                        },
                                    ]}
                                >
                                    <Text style={styles.reactionEmoji}>
                                        {emoji}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    {otherReaction ? (
                        <View style={styles.otherReactionRow}>
                            <Avatar
                                avatarUrl={
                                    otherReactionProfile?.avatarUrl ?? null
                                }
                                displayName={
                                    otherReactionProfile?.displayName ??
                                    'Former user'
                                }
                                seedId={
                                    otherReactionProfile?.userId ??
                                    otherReaction.userId
                                }
                                size={20}
                            />
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {(
                                    otherReactionProfile?.displayName ??
                                    'Former user'
                                ).split(/\s+/)[0]}{' '}
                                reacted {otherReaction.emoji}
                            </Text>
                        </View>
                    ) : null}

                    {/* Comments section. */}
                    <Text
                        style={[
                            typography.micro,
                            styles.sectionHeading,
                            { color: palette.textMuted, marginTop: spacing.lg },
                        ]}
                    >
                        COMMENTS
                    </Text>
                    {comments.length === 0 ? (
                        <Text
                            style={[
                                typography.caption,
                                styles.commentsEmpty,
                                { color: palette.textMuted },
                            ]}
                        >
                            No comments yet — say something.
                        </Text>
                    ) : (
                        <View style={styles.commentsList}>
                            {comments.map((c) => {
                                const isMine = c.userId === myUserId;
                                const authorName =
                                    c.author?.displayName ?? 'Deleted user';
                                // Full reaction list for this comment —
                                // rendered as a persistent badge under the
                                // body, one chip per (user, emoji). Tap
                                // semantics live in the long-press popover;
                                // the badge is display-only.
                                const cReactionList =
                                    commentReactions.get(c.id) ?? [];
                                return (
                                    <Pressable
                                        key={c.id}
                                        onLongPress={(e) =>
                                            setCommentMenuFor({
                                                commentId: c.id,
                                                anchorY:
                                                    e.nativeEvent.pageY,
                                                isOwn: isMine,
                                            })
                                        }
                                        style={styles.commentRow}
                                    >
                                        <Avatar
                                            avatarUrl={
                                                c.author?.avatarUrl ?? null
                                            }
                                            displayName={authorName}
                                            seedId={
                                                c.userId ?? `deleted:${c.id}`
                                            }
                                            size={28}
                                        />
                                        <View style={styles.commentText}>
                                            <View style={styles.commentMeta}>
                                                <Text
                                                    style={[
                                                        typography.caption,
                                                        {
                                                            color: palette.text,
                                                            fontWeight: '600',
                                                        },
                                                    ]}
                                                >
                                                    {isMine
                                                        ? 'You'
                                                        : authorName}
                                                </Text>
                                                <Text
                                                    style={[
                                                        typography.caption,
                                                        {
                                                            color: palette.textMuted,
                                                        },
                                                    ]}
                                                >
                                                    {relativeTimestamp(
                                                        c.createdAt,
                                                    )}
                                                </Text>
                                            </View>
                                            <Text
                                                style={[
                                                    typography.body,
                                                    { color: palette.text },
                                                ]}
                                            >
                                                {c.body}
                                            </Text>
                                            {cReactionList.length > 0 ? (
                                                <View
                                                    style={
                                                        styles.commentReactionsBadge
                                                    }
                                                >
                                                    {cReactionList.map((r) => {
                                                        const mine =
                                                            r.userId ===
                                                            myUserId;
                                                        return (
                                                            <View
                                                                key={r.userId}
                                                                style={[
                                                                    styles.commentReactionChip,
                                                                    {
                                                                        backgroundColor:
                                                                            mine
                                                                                ? palette.accent
                                                                                : palette.surfaceAlt,
                                                                    },
                                                                ]}
                                                            >
                                                                <Text
                                                                    style={
                                                                        styles.commentReactionChipEmoji
                                                                    }
                                                                >
                                                                    {r.emoji}
                                                                </Text>
                                                            </View>
                                                        );
                                                    })}
                                                </View>
                                            ) : null}
                                        </View>
                                    </Pressable>
                                );
                            })}
                        </View>
                    )}
                </ScrollView>

                {/* Composer pinned to the bottom of the keyboard
                    avoidance container. Reads as its own zone via a
                    palette.surface fill + 1pt borderStrong top edge +
                    a soft upward shadow (iOS) / elevation (Android),
                    since surface and bg are too close in tone for the
                    fill alone to register. paddingBottom adds breathing
                    room ABOVE the safe-area inset so the controls
                    aren't glued to the screen edge when the keyboard
                    is dismissed. Disabled state mirrors the button's
                    enable rule so the affordance stays obvious. */}
                <View
                    style={[
                        styles.composer,
                        {
                            backgroundColor: palette.surface,
                            borderTopColor: palette.borderStrong,
                            paddingBottom: insets.bottom + spacing.sm,
                        },
                    ]}
                >
                    <TextInput
                        value={composer}
                        onChangeText={setComposer}
                        placeholder="Write a comment…"
                        placeholderTextColor={palette.textMuted}
                        editable={!composerBusy}
                        multiline
                        maxLength={COMMENT_MAX_CHARS}
                        style={[
                            styles.composerInput,
                            typography.body,
                            {
                                color: palette.text,
                                backgroundColor: palette.bg,
                                borderColor: palette.borderStrong,
                            },
                        ]}
                    />
                    <Pressable
                        onPress={handlePostComment}
                        disabled={
                            composerBusy ||
                            composer.trim().length === 0 ||
                            composer.length > COMMENT_MAX_CHARS
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Post comment"
                        style={({ pressed }) => [
                            styles.composerSend,
                            {
                                // Always accent-tinted so the button reads
                                // as actionable. Empty state uses the
                                // subtle accent wash + accent icon; with
                                // content it flips to a filled accent
                                // pill with inverse icon.
                                backgroundColor:
                                    composer.trim().length === 0
                                        ? palette.accentSubtle
                                        : palette.accent,
                                opacity:
                                    pressed || composerBusy ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Send
                            color={
                                composer.trim().length === 0
                                    ? palette.accent
                                    : palette.textInverse
                            }
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                </View>
            </KeyboardAvoidingView>
            {/* Long-press popover for comment reactions + per-comment
                actions. Lean version: no full-screen dim, no spring
                animation, no haptics. The backdrop Pressable is a
                sibling of the popover (NOT a parent) so taps on the
                popover's emoji / action Pressables capture first; taps
                outside the popover land on the backdrop and dismiss. */}
            <Modal
                transparent
                visible={!!commentMenuFor}
                animationType="none"
                onRequestClose={() => setCommentMenuFor(null)}
            >
                <Pressable
                    style={StyleSheet.absoluteFillObject}
                    onPress={() => setCommentMenuFor(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Close menu"
                />
                {commentMenuFor ? (
                    <View
                        pointerEvents="box-none"
                        style={[
                            styles.commentMenuContainer,
                            { top: commentMenuFor.anchorY },
                        ]}
                    >
                        <View
                            style={[
                                styles.commentMenu,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: palette.border,
                                },
                            ]}
                        >
                            <View style={styles.commentMenuEmojiRow}>
                                {REACTION_EMOJIS.map((emoji) => (
                                    <Pressable
                                        key={emoji}
                                        onPress={() => {
                                            const cid =
                                                commentMenuFor.commentId;
                                            setCommentMenuFor(null);
                                            void handleCommentReactionTap(
                                                cid,
                                                emoji,
                                            );
                                        }}
                                        accessibilityRole="button"
                                        accessibilityLabel={`React with ${emoji}`}
                                        style={({ pressed }) => [
                                            styles.commentMenuEmojiCell,
                                            {
                                                backgroundColor:
                                                    palette.surfaceAlt,
                                                opacity: pressed ? 0.6 : 1,
                                            },
                                        ]}
                                    >
                                        <Text style={styles.reactionEmoji}>
                                            {emoji}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                            {/* Actions menu — only for own comments. Built
                                as a mapped array so adding Edit (or any
                                future item) is one line, not a refactor.
                                Each item dismisses the popover before
                                calling its handler so any follow-up
                                dialog (Alert) lands on a clean screen. */}
                            {commentMenuFor.isOwn ? (
                                <View
                                    style={[
                                        styles.commentMenuActions,
                                        { borderTopColor: palette.border },
                                    ]}
                                >
                                    {(
                                        [
                                            {
                                                label: 'Delete',
                                                destructive: true,
                                                onPress: () => {
                                                    const cid =
                                                        commentMenuFor.commentId;
                                                    setCommentMenuFor(null);
                                                    handleDeleteComment(cid);
                                                },
                                            },
                                        ] as Array<{
                                            label: string;
                                            destructive?: boolean;
                                            onPress: () => void;
                                        }>
                                    ).map((action) => (
                                        <Pressable
                                            key={action.label}
                                            onPress={action.onPress}
                                            accessibilityRole="button"
                                            accessibilityLabel={action.label}
                                            style={({ pressed }) => [
                                                styles.commentMenuActionItem,
                                                { opacity: pressed ? 0.6 : 1 },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    typography.body,
                                                    {
                                                        color: action.destructive
                                                            ? palette.error
                                                            : palette.text,
                                                    },
                                                ]}
                                            >
                                                {action.label}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </View>
                            ) : null}
                        </View>
                    </View>
                ) : null}
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
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
        paddingHorizontal: spacing.base,
        paddingTop: spacing.xxl,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    headerText: {
        flex: 1,
        gap: spacing.xs,
    },
    note: {
        fontStyle: 'italic',
        marginTop: spacing.md,
    },
    titleCard: {
        marginTop: spacing.lg,
        flexDirection: 'row',
        gap: spacing.md,
        padding: spacing.md,
        borderRadius: radius.sm,
    },
    poster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    titleText: {
        flex: 1,
        gap: spacing.xs,
        justifyContent: 'space-between',
    },
    viewTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    sectionHeading: {
        letterSpacing: 1.2,
        marginTop: spacing.xl,
        marginBottom: spacing.sm,
    },
    reactionRow: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    reactionCell: {
        width: REACTION_PICKER_SIZE,
        height: REACTION_PICKER_SIZE,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    reactionEmoji: {
        fontSize: 22,
        lineHeight: 24,
    },
    otherReactionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: spacing.md,
    },
    commentsEmpty: {
        marginTop: spacing.xs,
    },
    commentsList: {
        gap: spacing.md,
    },
    commentRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'flex-start',
    },
    commentText: {
        flex: 1,
        gap: spacing.xs,
    },
    commentMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        // paddingBottom is set inline (safe-area inset + spacing).
        borderTopWidth: 1,
        // Soft upward shadow so the bar floats above the scrolling
        // content. iOS supports negative shadowOffset directly; Android
        // ignores negative offsets but still draws elevation, which
        // gives us a thin separation line — good enough as a fallback.
        // shadowColor stays hardcoded '#000' deliberately: it's
        // theme-independent (palette.shadow is '#000000' in both
        // light and dark) and this is a static StyleSheet.create where
        // palette isn't in scope. Visibility is controlled by
        // shadowOpacity below, not the base color.
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
        elevation: 8,
    },
    composerInput: {
        flex: 1,
        maxHeight: 120,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
    },
    composerSend: {
        width: 40,
        height: 40,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Container spans the full width at the anchored Y so its child
    // popover can self-center horizontally. pointerEvents='box-none' on
    // the container lets backdrop taps fall through any empty space
    // around the popover sheet itself.
    commentMenuContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
        paddingHorizontal: spacing.base,
    },
    commentMenu: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        paddingVertical: spacing.sm,
        minWidth: 240,
        maxWidth: 320,
    },
    commentMenuEmojiRow: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingHorizontal: spacing.sm,
    },
    commentMenuEmojiCell: {
        width: REACTION_PICKER_SIZE,
        height: REACTION_PICKER_SIZE,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    commentMenuActions: {
        marginTop: spacing.sm,
        paddingTop: spacing.sm,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    commentMenuActionItem: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    // Resting-state badge under each comment body. `commentText` has
    // gap: spacing.xs between siblings, so no marginTop here. flexWrap
    // so a future widening of the emoji set or multi-party threads
    // can grow vertically without overflowing the row.
    commentReactionsBadge: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
    },
    commentReactionChip: {
        paddingHorizontal: spacing.xs,
        paddingVertical: 2,
        borderRadius: radius.full,
        minHeight: 22,
        minWidth: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    commentReactionChipEmoji: {
        fontSize: 14,
        lineHeight: 16,
    },
});
