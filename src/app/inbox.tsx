import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
import { maybeEnablePushAfterAccept } from '@/lib/push';
import supabase from '@/lib/supabase';
import { getMovie, getTV } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

type MediaType = 'movie' | 'tv';

interface ProfileSummary {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

interface IncomingRecItem {
    kind: 'incoming_rec';
    id: string;
    createdAt: string;
    recId: string;
    tmdbId: number;
    mediaType: MediaType;
    note: string | null;
    sender: ProfileSummary;
    titleName: string | null;
}

interface FriendRequestItem {
    kind: 'friend_request';
    id: string;
    createdAt: string;
    requestId: string;
    sender: ProfileSummary;
}

interface RecWatchedItem {
    kind: 'notification_rec_watched';
    id: string;
    createdAt: string;
    notificationId: string;
    watcher: ProfileSummary;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
}

interface FriendAcceptedItem {
    kind: 'notification_friend_accepted';
    id: string;
    createdAt: string;
    notificationId: string;
    friend: ProfileSummary;
}

interface RecReactedItem {
    kind: 'notification_rec_reacted';
    id: string;
    createdAt: string;
    notificationId: string;
    reactor: ProfileSummary;
    recId: string;
    emoji: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
}

interface RecCommentedItem {
    kind: 'notification_rec_commented';
    id: string;
    createdAt: string;
    notificationId: string;
    commenter: ProfileSummary;
    recId: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
}

type InboxItem =
    | IncomingRecItem
    | FriendRequestItem
    | RecWatchedItem
    | FriendAcceptedItem
    | RecReactedItem
    | RecCommentedItem;

const AVATAR_SIZE = 44;
const NOTE_PREVIEW_CHARS = 120;
const MAX_ITEMS = 50;

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

// Narrow `unknown` payload to a record we can probe for specific fields.
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function pickString(payload: Record<string, unknown> | null, key: string): string | null {
    const v = payload?.[key];
    return typeof v === 'string' ? v : null;
}

function pickNumber(payload: Record<string, unknown> | null, key: string): number | null {
    const v = payload?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickMediaType(
    payload: Record<string, unknown> | null,
    key: string,
): MediaType | null {
    const v = payload?.[key];
    return v === 'movie' || v === 'tv' ? v : null;
}

export default function InboxScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [items, setItems] = useState<InboxItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Three sources, in parallel. Mark notifications read at the
            // same time so the bell badge drops the moment the user opens
            // this screen (tabs refetch on focus and pick up the change).
            const [recsResult, requestsResult, notificationsResult, _markReadResult] =
                await Promise.all([
                    supabase
                        .from('recommendations')
                        .select('id, from_user_id, tmdb_id, media_type, note, sent_at')
                        .eq('to_user_id', userId)
                        .eq('status', 'pending')
                        .order('sent_at', { ascending: false })
                        .limit(MAX_ITEMS),
                    supabase
                        .from('friend_requests')
                        .select('id, from_user_id, created_at')
                        .eq('to_user_id', userId)
                        .order('created_at', { ascending: false })
                        .limit(MAX_ITEMS),
                    supabase
                        .from('notifications')
                        .select('id, kind, payload, created_at')
                        .eq('user_id', userId)
                        .in('kind', [
                            'rec_watched',
                            'friend_accepted',
                            'rec_reacted',
                            'rec_commented',
                        ])
                        .order('created_at', { ascending: false })
                        .limit(MAX_ITEMS),
                    supabase
                        .from('notifications')
                        .update({ read_at: new Date().toISOString() })
                        .eq('user_id', userId)
                        .is('read_at', null),
                ]);

            if (recsResult.error) throw recsResult.error;
            if (requestsResult.error) throw requestsResult.error;
            if (notificationsResult.error) throw notificationsResult.error;

            const recs = recsResult.data ?? [];
            const requests = requestsResult.data ?? [];
            const notifications = notificationsResult.data ?? [];

            // Collect every other-party userId across the three sources
            // and batch the profile lookup into one query.
            const otherUserIds = new Set<string>();
            for (const r of recs) {
                if (r.from_user_id) otherUserIds.add(r.from_user_id);
            }
            for (const r of requests) {
                otherUserIds.add(r.from_user_id);
            }
            for (const n of notifications) {
                const payload = asRecord(n.payload);
                if (n.kind === 'rec_watched') {
                    const id = pickString(payload, 'to_user_id');
                    if (id) otherUserIds.add(id);
                } else if (n.kind === 'friend_accepted') {
                    const id = pickString(payload, 'from_user_id');
                    if (id) otherUserIds.add(id);
                } else if (
                    n.kind === 'rec_reacted' ||
                    n.kind === 'rec_commented'
                ) {
                    // Reactor / commenter is the other party on the
                    // rec — payload.from_user_id per the trigger.
                    const id = pickString(payload, 'from_user_id');
                    if (id) otherUserIds.add(id);
                }
            }

            const profilesById = new Map<string, ProfileSummary>();
            if (otherUserIds.size > 0) {
                const { data: profiles, error: profilesError } = await supabase
                    .from('profiles')
                    .select('id, handle, display_name, avatar_url')
                    .in('id', Array.from(otherUserIds));
                if (profilesError) throw profilesError;
                for (const p of profiles ?? []) {
                    profilesById.set(p.id, {
                        userId: p.id,
                        handle: p.handle,
                        displayName: p.display_name,
                        avatarUrl: p.avatar_url,
                    });
                }
            }

            const placeholderProfile: ProfileSummary = {
                userId: '',
                handle: 'unknown',
                displayName: 'Unknown user',
                avatarUrl: null,
            };

            // TMDB title fetches for incoming recs + rec_watched
            // notifications, in parallel via Promise.allSettled so one
            // failure doesn't break the whole inbox.
            type TitleKey = string; // `${mediaType}:${tmdbId}`
            const titleKeys = new Set<TitleKey>();
            for (const r of recs) {
                titleKeys.add(`${r.media_type}:${r.tmdb_id}`);
            }
            for (const n of notifications) {
                if (
                    n.kind !== 'rec_watched' &&
                    n.kind !== 'rec_reacted' &&
                    n.kind !== 'rec_commented'
                ) {
                    continue;
                }
                const payload = asRecord(n.payload);
                const mt = pickMediaType(payload, 'media_type');
                const tid = pickNumber(payload, 'tmdb_id');
                if (mt && tid) titleKeys.add(`${mt}:${tid}`);
            }

            const titleByKey = new Map<TitleKey, string>();
            if (titleKeys.size > 0) {
                const keys = Array.from(titleKeys);
                const results = await Promise.allSettled(
                    keys.map(async (key) => {
                        const [mt, tidStr] = key.split(':');
                        const tid = Number.parseInt(tidStr ?? '', 10);
                        if (!Number.isFinite(tid)) return null;
                        const data =
                            mt === 'movie' ? await getMovie(tid) : await getTV(tid);
                        return 'title' in data ? data.title : data.name;
                    }),
                );
                results.forEach((res, i) => {
                    const key = keys[i];
                    if (!key) return;
                    if (res.status === 'fulfilled' && res.value !== null) {
                        titleByKey.set(key, res.value);
                    }
                });
            }

            const inboxItems: InboxItem[] = [];

            for (const r of recs) {
                const sender = r.from_user_id
                    ? profilesById.get(r.from_user_id) ?? placeholderProfile
                    : { ...placeholderProfile, displayName: 'Former user' };
                inboxItems.push({
                    kind: 'incoming_rec',
                    id: `rec:${r.id}`,
                    createdAt: r.sent_at,
                    recId: r.id,
                    tmdbId: r.tmdb_id,
                    mediaType: r.media_type as MediaType,
                    note: r.note,
                    sender,
                    titleName: titleByKey.get(`${r.media_type}:${r.tmdb_id}`) ?? null,
                });
            }

            for (const r of requests) {
                const sender = profilesById.get(r.from_user_id) ?? placeholderProfile;
                inboxItems.push({
                    kind: 'friend_request',
                    id: `req:${r.id}`,
                    createdAt: r.created_at,
                    requestId: r.id,
                    sender,
                });
            }

            for (const n of notifications) {
                const payload = asRecord(n.payload);
                if (n.kind === 'rec_watched') {
                    const watcherId = pickString(payload, 'to_user_id');
                    const watcher = watcherId
                        ? profilesById.get(watcherId) ?? placeholderProfile
                        : placeholderProfile;
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    inboxItems.push({
                        kind: 'notification_rec_watched',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        watcher,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName:
                            mt && tid ? titleByKey.get(`${mt}:${tid}`) ?? null : null,
                    });
                } else if (n.kind === 'friend_accepted') {
                    const friendId = pickString(payload, 'from_user_id');
                    const friend = friendId
                        ? profilesById.get(friendId) ?? placeholderProfile
                        : placeholderProfile;
                    inboxItems.push({
                        kind: 'notification_friend_accepted',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        friend,
                    });
                } else if (n.kind === 'rec_reacted') {
                    const reactorId = pickString(payload, 'from_user_id');
                    const reactor = reactorId
                        ? profilesById.get(reactorId) ?? placeholderProfile
                        : placeholderProfile;
                    const recId = pickString(payload, 'recommendation_id');
                    const emoji = pickString(payload, 'emoji') ?? '';
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!recId) continue;
                    inboxItems.push({
                        kind: 'notification_rec_reacted',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        reactor,
                        recId,
                        emoji,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName:
                            mt && tid
                                ? titleByKey.get(`${mt}:${tid}`) ?? null
                                : null,
                    });
                } else if (n.kind === 'rec_commented') {
                    const commenterId = pickString(payload, 'from_user_id');
                    const commenter = commenterId
                        ? profilesById.get(commenterId) ?? placeholderProfile
                        : placeholderProfile;
                    const recId = pickString(payload, 'recommendation_id');
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!recId) continue;
                    inboxItems.push({
                        kind: 'notification_rec_commented',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        commenter,
                        recId,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName:
                            mt && tid
                                ? titleByKey.get(`${mt}:${tid}`) ?? null
                                : null,
                    });
                }
            }

            inboxItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            setItems(inboxItems.slice(0, MAX_ITEMS));
        } catch (err) {
            console.error('inbox fetch failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load inbox');
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            load();
        }, [load]),
    );

    async function handleAccept(requestId: string) {
        if (actionBusy) return;
        setActionBusy(requestId);
        try {
            const { error: rpcError } = await supabase.rpc('accept_friend_request', {
                request_id: requestId,
            });
            if (rpcError) throw rpcError;
            setItems((prev) =>
                prev.filter(
                    (it) => !(it.kind === 'friend_request' && it.requestId === requestId),
                ),
            );

            // Social-commitment moment: this is where it's natural to ask
            // for push permissions. Helper is silent on every error so a
            // permission hiccup can't surface as an Accept failure.
            const {
                data: { session },
            } = await supabase.auth.getSession();
            if (session?.user.id) {
                await maybeEnablePushAfterAccept(session.user.id);
            }
        } catch (err) {
            console.error('accept failed:', err);
            Alert.alert(
                "Couldn't accept",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setActionBusy(null);
        }
    }

    async function handleDecline(requestId: string) {
        if (actionBusy) return;
        setActionBusy(requestId);
        try {
            const { error: rpcError } = await supabase.rpc('decline_friend_request', {
                request_id: requestId,
            });
            if (rpcError) throw rpcError;
            setItems((prev) =>
                prev.filter(
                    (it) => !(it.kind === 'friend_request' && it.requestId === requestId),
                ),
            );
        } catch (err) {
            console.error('decline failed:', err);
            Alert.alert(
                "Couldn't decline",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setActionBusy(null);
        }
    }

    function renderIncomingRec(item: IncomingRecItem) {
        const title = item.titleName ?? 'this title';
        const notePreview =
            item.note && item.note.length > NOTE_PREVIEW_CHARS
                ? `${item.note.slice(0, NOTE_PREVIEW_CHARS)}…`
                : item.note;
        return (
            <Pressable
                onPress={() => router.push(`/rec/${item.recId}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Avatar
                    avatarUrl={item.sender.avatarUrl}
                    displayName={item.sender.displayName}
                    seedId={item.sender.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.sender.displayName}
                        </Text>{' '}
                        recommended <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    {notePreview && (
                        <Text
                            style={[
                                typography.caption,
                                styles.note,
                                { color: palette.textMuted },
                            ]}
                            numberOfLines={2}
                        >
                            “{notePreview}”
                        </Text>
                    )}
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderFriendRequest(item: FriendRequestItem) {
        const busy = actionBusy === item.requestId;
        return (
            <View style={styles.row}>
                <Avatar
                    avatarUrl={item.sender.avatarUrl}
                    displayName={item.sender.displayName}
                    seedId={item.sender.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.sender.displayName}
                        </Text>{' '}
                        <Text style={{ color: palette.textMuted }}>
                            (@{item.sender.handle})
                        </Text>{' '}
                        wants to be your friend
                    </Text>
                    <View style={styles.requestActions}>
                        <Pressable
                            onPress={() => handleAccept(item.requestId)}
                            disabled={busy}
                            style={({ pressed }) => [
                                styles.acceptButton,
                                {
                                    backgroundColor: palette.accent,
                                    opacity: pressed || busy ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.caption,
                                    {
                                        color: palette.textInverse,
                                        fontWeight: '600',
                                    },
                                ]}
                            >
                                Accept
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => handleDecline(item.requestId)}
                            disabled={busy}
                            style={({ pressed }) => [
                                styles.declineButton,
                                {
                                    borderColor: palette.border,
                                    opacity: pressed || busy ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.caption,
                                    {
                                        color: palette.textMuted,
                                        fontWeight: '600',
                                    },
                                ]}
                            >
                                Decline
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        );
    }

    function renderRecWatched(item: RecWatchedItem) {
        const title = item.titleName ?? 'your rec';
        const canNavigate = !!(item.mediaType && item.tmdbId);
        return (
            <Pressable
                onPress={() => {
                    if (canNavigate) {
                        router.push(`/title/${item.mediaType}/${item.tmdbId}`);
                    }
                }}
                disabled={!canNavigate}
                style={({ pressed }) => [
                    styles.row,
                    pressed && canNavigate && { opacity: 0.6 },
                ]}
            >
                <Avatar
                    avatarUrl={item.watcher.avatarUrl}
                    displayName={item.watcher.displayName}
                    seedId={item.watcher.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.watcher.displayName}
                        </Text>{' '}
                        watched <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderFriendAccepted(item: FriendAcceptedItem) {
        return (
            <Pressable
                onPress={() => router.push(`/friends/${item.friend.handle}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Avatar
                    avatarUrl={item.friend.avatarUrl}
                    displayName={item.friend.displayName}
                    seedId={item.friend.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.friend.displayName}
                        </Text>{' '}
                        is now your friend
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderRecReacted(item: RecReactedItem) {
        const title = item.titleName ?? 'your rec';
        return (
            <Pressable
                onPress={() => router.push(`/rec/${item.recId}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Avatar
                    avatarUrl={item.reactor.avatarUrl}
                    displayName={item.reactor.displayName}
                    seedId={item.reactor.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.reactor.displayName}
                        </Text>{' '}
                        reacted {item.emoji} to{' '}
                        <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderRecCommented(item: RecCommentedItem) {
        const title = item.titleName ?? 'your rec';
        return (
            <Pressable
                onPress={() => router.push(`/rec/${item.recId}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Avatar
                    avatarUrl={item.commenter.avatarUrl}
                    displayName={item.commenter.displayName}
                    seedId={item.commenter.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.commenter.displayName}
                        </Text>{' '}
                        commented on{' '}
                        <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderRow({ item }: { item: InboxItem }) {
        switch (item.kind) {
            case 'incoming_rec':
                return renderIncomingRec(item);
            case 'friend_request':
                return renderFriendRequest(item);
            case 'notification_rec_watched':
                return renderRecWatched(item);
            case 'notification_friend_accepted':
                return renderFriendAccepted(item);
            case 'notification_rec_reacted':
                return renderRecReacted(item);
            case 'notification_rec_commented':
                return renderRecCommented(item);
        }
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Inbox" showBackButton hideBell />

            {loading ? (
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : error ? (
                <View style={styles.fillCenter}>
                    <Text
                        style={[typography.body, { color: palette.error }]}
                        numberOfLines={3}
                    >
                        {error}
                    </Text>
                </View>
            ) : items.length === 0 ? (
                <View style={styles.fillCenter}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={3}
                    >
                        Nothing here yet. Recs and friend requests will show up when
                        they come in.
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    renderItem={renderRow}
                    contentContainerStyle={styles.listContent}
                    ItemSeparatorComponent={() => (
                        <View
                            style={[styles.separator, { backgroundColor: palette.border }]}
                        />
                    )}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.lg,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    note: {
        fontStyle: 'italic',
    },
    requestActions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.xs,
    },
    acceptButton: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
    },
    declineButton: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: AVATAR_SIZE + spacing.md,
    },
});
