import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { CheckCircle, XCircle } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
    Alert,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
import { SegmentedControl } from '@/components/segmented-control';
import { UserLink } from '@/components/user-link';
import { formatLibraryBadge, type ItemStatus } from '@/lib/item-status';
import { goToProfile } from '@/lib/profile-nav';
import { maybeEnablePushAfterAccept } from '@/lib/push';
import { formatRatingStars } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

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
    // The rec's own lifecycle state. 'pending' = active "wants you to
    // watch this"; 'watched' = the recipient has watched it (the rec
    // stays in the list for the post-watch conversation, visually marked);
    // 'dismissed' = the recipient passed on it (stays in the list greyed,
    // marked "Passed" — declining IS the action, so it's done not gone).
    recStatus: 'pending' | 'watched' | 'dismissed';
    // The recipient's existing relationship to this title, if any.
    // Drives the compact "Watched · 4★" / "Watchlist" / "Watching"
    // badge on the rec card so the user sees their library status
    // before tapping in. null = title isn't in the recipient's
    // library, so no badge renders. Sourced from a batched items
    // lookup keyed on the rec'd tmdb_ids — see load().
    libraryStatus: { status: ItemStatus; rating: number | null } | null;
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

// Sender-side: a recipient passed on this rec WITH a note (silent declines
// never create a notification, so `note` is always present here).
interface RecDeclinedItem {
    kind: 'notification_rec_declined';
    id: string;
    createdAt: string;
    notificationId: string;
    decliner: ProfileSummary;
    recId: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
    note: string | null;
}

// A friend asked the current user for a recommendation (v1 untied — no
// rec/title attached). Tapping it opens the title picker pre-targeted to the
// requester so the user can send a normal rec back.
interface RecRequestedItem {
    kind: 'notification_rec_requested';
    id: string;
    createdAt: string;
    notificationId: string;
    requester: ProfileSummary;
    note: string | null;
}

type InboxItem =
    | IncomingRecItem
    | FriendRequestItem
    | RecWatchedItem
    | FriendAcceptedItem
    | RecReactedItem
    | RecCommentedItem
    | RecDeclinedItem
    | RecRequestedItem;

// Sent recs are NOT unioned into InboxItem — different render path, no
// notification semantics, no badge effects. Multi-recipient sends create
// one recommendations row per recipient, which surfaces here as one row
// per recipient by design (no grouping by title).
interface SentRecItem {
    id: string;
    sentAt: string;
    recId: string;
    tmdbId: number;
    mediaType: MediaType;
    titleName: string | null;
    posterPath: string | null;
    recipient: ProfileSummary;
}

// titleByKey holds title + poster path so Sent rows can render a poster
// thumbnail. Received call sites only read .title — they're updated in
// place to use .title ?? null.
interface TitleMeta {
    title: string;
    posterPath: string | null;
}

type InboxView = 'received' | 'sent';

// Options for the shared SegmentedControl (Received / Sent toggle).
// Module-scope so the array reference is stable across renders.
const INBOX_VIEW_OPTIONS: ReadonlyArray<{ value: InboxView; label: string }> = [
    { value: 'received', label: 'Received' },
    { value: 'sent', label: 'Sent' },
];

const AVATAR_SIZE = 44;
const SENT_POSTER_WIDTH = 56;
const SENT_POSTER_HEIGHT = 84;
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
    const [sentItems, setSentItems] = useState<SentRecItem[]>([]);
    const [view, setView] = useState<InboxView>('received');
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState<string | null>(null);
    // Notification ids that were unread the moment the inbox opened THIS
    // visit — snapshotted before the on-focus read-sweep marks them read.
    // Drives the per-row unread dot for this viewing only (option C); the
    // sweep still clears read_at, so the next visit starts clean.
    const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Snapshot which notification rows are unread RIGHT NOW —
            // sequentially, BEFORE the read-sweep in the batch below marks
            // them read (the sweep races the SELECT inside the same batch,
            // and the notifications SELECT doesn't fetch read_at anyway).
            // Best-effort: on error the snapshot is empty (no dots), never
            // a broken inbox. This is the option-C "unread as of when I
            // opened" source; the sweep still clears read_at so next visit
            // is clean.
            const unreadSnapshotRes = await supabase
                .from('notifications')
                .select('id')
                .eq('user_id', userId)
                .is('read_at', null);
            const unreadSnapshot = new Set(
                (unreadSnapshotRes.data ?? []).map((r) => r.id),
            );

            // Four read sources + one notifications-read sweep, in
            // parallel. The Sent query is unconditional even when the
            // toggle is on Received so flipping to Sent is instant; the
            // network cost is one extra small query + any new title /
            // recipient lookups, which fold into the existing batches.
            // Mark notifications read at the same time so the bell badge
            // drops the moment the user opens this screen (tabs refetch
            // on focus and pick up the change).
            const [
                recsResult,
                requestsResult,
                notificationsResult,
                sentRecsResult,
                _markReadResult,
            ] = await Promise.all([
                // Received = pending + watched + dismissed recs (NOT
                // pending-only). The post-watch conversation lives on the
                // rec, so a watched rec stays in the list shown in its
                // watched state; a dismissed ("passed") rec also stays,
                // greyed — declining is an action taken, not a reason to
                // vanish (mirrors watched). Only the unused 'accepted' is
                // absent. Badge still counts pending-only, so dismissed
                // here doesn't re-create an actionable nag.
                supabase
                    .from('recommendations')
                    .select(
                        'id, from_user_id, tmdb_id, media_type, note, sent_at, status',
                    )
                    .eq('to_user_id', userId)
                    .in('status', ['pending', 'watched', 'dismissed'])
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
                        'rec_declined',
                        'rec_requested',
                    ])
                    .order('created_at', { ascending: false })
                    .limit(MAX_ITEMS),
                // Sent recs — no status filter; one row per (title, recipient)
                // by construction, which is the desired "one line per recipient"
                // semantic. Recipient profile + title meta hydrate via the
                // existing shared batches below.
                supabase
                    .from('recommendations')
                    .select('id, to_user_id, tmdb_id, media_type, sent_at')
                    .eq('from_user_id', userId)
                    .order('sent_at', { ascending: false })
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
            if (sentRecsResult.error) throw sentRecsResult.error;

            const recs = recsResult.data ?? [];
            const requests = requestsResult.data ?? [];
            const notifications = notificationsResult.data ?? [];
            const sentRecs = sentRecsResult.data ?? [];

            // Collect every other-party userId across all sources
            // (including Sent recipients) and batch the profile lookup
            // into one query. Sent recipients land in profilesById right
            // alongside Received senders for free.
            const otherUserIds = new Set<string>();
            for (const r of recs) {
                if (r.from_user_id) otherUserIds.add(r.from_user_id);
            }
            for (const r of requests) {
                otherUserIds.add(r.from_user_id);
            }
            for (const r of sentRecs) {
                otherUserIds.add(r.to_user_id);
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
                    n.kind === 'rec_commented' ||
                    n.kind === 'rec_declined' ||
                    n.kind === 'rec_requested'
                ) {
                    // Reactor / commenter / decliner / requester is the
                    // other party — payload.from_user_id per the trigger/RPC.
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

            // TMDB title + poster fetches for incoming recs, sent recs,
            // and title-bearing notifications, in parallel via
            // Promise.allSettled so one failure doesn't break the whole
            // inbox. Sent rows need posterPath; Received rows only read
            // .title — both flow through the same shared cache.
            type TitleKey = string; // `${mediaType}:${tmdbId}`
            const titleKeys = new Set<TitleKey>();
            for (const r of recs) {
                titleKeys.add(`${r.media_type}:${r.tmdb_id}`);
            }
            for (const r of sentRecs) {
                titleKeys.add(`${r.media_type}:${r.tmdb_id}`);
            }
            for (const n of notifications) {
                if (
                    n.kind !== 'rec_watched' &&
                    n.kind !== 'rec_reacted' &&
                    n.kind !== 'rec_commented' &&
                    n.kind !== 'rec_declined'
                ) {
                    continue;
                }
                const payload = asRecord(n.payload);
                const mt = pickMediaType(payload, 'media_type');
                const tid = pickNumber(payload, 'tmdb_id');
                if (mt && tid) titleKeys.add(`${mt}:${tid}`);
            }

            const titleByKey = new Map<TitleKey, TitleMeta>();
            if (titleKeys.size > 0) {
                const keys = Array.from(titleKeys);
                const results = await Promise.allSettled(
                    keys.map(async (key): Promise<TitleMeta | null> => {
                        const [mt, tidStr] = key.split(':');
                        const tid = Number.parseInt(tidStr ?? '', 10);
                        if (!Number.isFinite(tid)) return null;
                        const data =
                            mt === 'movie' ? await getMovie(tid) : await getTV(tid);
                        return {
                            title:
                                'title' in data ? data.title : data.name,
                            posterPath: data.poster_path,
                        };
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

            // Library-status lookup for the recipient's own items rows
            // on the rec'd titles. One batched query filtered by
            // user_id + tmdb_id IN (distinct rec'd ids), stitched
            // client-side by `${media_type}:${tmdb_id}` so per-card
            // lookup in renderIncomingRec is O(1). The .in('tmdb_id',
            // …) may pull a slight superset (e.g. items for the
            // movie-version of a tmdb_id we only wanted the tv-version
            // of) — the composite-key stitch filters those out
            // cleanly. Cheaper and clearer than chaining .or(and(…))
            // pairs for true composite-key filtering. Best-effort:
            // query failure renders the inbox without the badges
            // rather than blocking the whole load.
            type LibraryStatusValue = {
                status: ItemStatus;
                rating: number | null;
            };
            const libraryStatusByKey = new Map<string, LibraryStatusValue>();
            const recTmdbIds = Array.from(
                new Set(recs.map((r) => r.tmdb_id)),
            );
            if (recTmdbIds.length > 0) {
                const { data: itemRows, error: itemsError } = await supabase
                    .from('items')
                    .select('tmdb_id, media_type, status, rating')
                    .eq('user_id', userId)
                    .in('tmdb_id', recTmdbIds);
                if (itemsError) {
                    console.warn(
                        'inbox library-status fetch failed:',
                        itemsError,
                    );
                } else {
                    for (const row of itemRows ?? []) {
                        const status = row.status;
                        if (
                            status !== 'watchlist' &&
                            status !== 'watching' &&
                            status !== 'watched'
                        ) {
                            continue;
                        }
                        libraryStatusByKey.set(
                            `${row.media_type}:${row.tmdb_id}`,
                            {
                                status,
                                rating:
                                    typeof row.rating === 'number'
                                        ? row.rating
                                        : null,
                            },
                        );
                    }
                }
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
                    titleName:
                        titleByKey.get(`${r.media_type}:${r.tmdb_id}`)?.title ??
                        null,
                    recStatus:
                        r.status === 'watched'
                            ? 'watched'
                            : r.status === 'dismissed'
                              ? 'dismissed'
                              : 'pending',
                    libraryStatus:
                        libraryStatusByKey.get(
                            `${r.media_type}:${r.tmdb_id}`,
                        ) ?? null,
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
                            mt && tid
                                ? titleByKey.get(`${mt}:${tid}`)?.title ?? null
                                : null,
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
                                ? titleByKey.get(`${mt}:${tid}`)?.title ?? null
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
                                ? titleByKey.get(`${mt}:${tid}`)?.title ?? null
                                : null,
                    });
                } else if (n.kind === 'rec_declined') {
                    const declinerId = pickString(payload, 'from_user_id');
                    const decliner = declinerId
                        ? profilesById.get(declinerId) ?? placeholderProfile
                        : placeholderProfile;
                    const recId = pickString(payload, 'recommendation_id');
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!recId) continue;
                    inboxItems.push({
                        kind: 'notification_rec_declined',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        decliner,
                        recId,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName:
                            mt && tid
                                ? titleByKey.get(`${mt}:${tid}`)?.title ?? null
                                : null,
                        note: pickString(payload, 'note'),
                    });
                } else if (n.kind === 'rec_requested') {
                    const requesterId = pickString(payload, 'from_user_id');
                    if (!requesterId) continue;
                    const requester =
                        profilesById.get(requesterId) ?? placeholderProfile;
                    inboxItems.push({
                        kind: 'notification_rec_requested',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        requester,
                        note: pickString(payload, 'note'),
                    });
                }
            }

            inboxItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            setItems(inboxItems.slice(0, MAX_ITEMS));
            // Apply the open-time snapshot alongside the rows so the dots
            // appear with this visit's data.
            setUnreadIds(unreadSnapshot);

            // Sent items. Query is already ordered newest-first, so a
            // second sort is redundant — but keep it defensive in case
            // recipient hydration ever reshuffles. Recipient profile is
            // ALWAYS resolvable for sent rows: to_user_id is non-null
            // per schema, and friends are RLS-readable; missing profile
            // means the recipient was deleted.
            const sentList: SentRecItem[] = [];
            for (const r of sentRecs) {
                const meta = titleByKey.get(`${r.media_type}:${r.tmdb_id}`);
                const recipient =
                    profilesById.get(r.to_user_id) ?? {
                        ...placeholderProfile,
                        displayName: 'Former user',
                    };
                sentList.push({
                    id: `sent:${r.id}`,
                    sentAt: r.sent_at,
                    recId: r.id,
                    tmdbId: r.tmdb_id,
                    mediaType: r.media_type as MediaType,
                    titleName: meta?.title ?? null,
                    posterPath: meta?.posterPath ?? null,
                    recipient,
                });
            }
            setSentItems(sentList.slice(0, MAX_ITEMS));
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
        const dimmed = item.recStatus === 'dismissed';
        return (
            <Pressable
                onPress={() => router.push(`/rec/${item.recId}`)}
                // Dismissed ("passed") recs read greyed — still tappable
                // (the conversation/undo lives on the rec page), just
                // visually settled, not an active ask.
                style={({ pressed }) => [
                    styles.row,
                    dimmed && styles.rowDimmed,
                    pressed && { opacity: 0.6 },
                ]}
            >
                <UserLink
                    handle={item.sender.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.sender.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.sender.avatarUrl}
                        displayName={item.sender.displayName}
                        seedId={item.sender.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.sender.handle })
                            }
                        >
                            {item.sender.displayName}
                        </Text>{' '}
                        recommended <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    {item.recStatus === 'watched' ? (
                        // Watched rec — a distinct accent marker ("Watched"
                        // + the user's rating if any) so it reads at a
                        // glance as done, not an active ask. Rating comes
                        // from the recipient's items row (libraryStatus).
                        <View
                            style={[
                                styles.watchedMarker,
                                { backgroundColor: palette.accentSubtle },
                            ]}
                            accessibilityLabel="You watched this"
                        >
                            <CheckCircle
                                color={palette.accent}
                                size={12}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                            <Text
                                style={[
                                    typography.micro,
                                    { color: palette.accent },
                                ]}
                            >
                                {item.libraryStatus?.rating != null
                                    ? `Watched · ${formatRatingStars(
                                          item.libraryStatus.rating,
                                      )}`
                                    : 'Watched'}
                            </Text>
                        </View>
                    ) : item.recStatus === 'dismissed' ? (
                        // Passed rec — neutral grey marker (X + "Passed"),
                        // distinct from the accent "Watched" pill and from
                        // the pending library badge. Reads as settled/done.
                        <View
                            style={[
                                styles.passedMarker,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                            accessibilityLabel="You passed on this"
                        >
                            <XCircle
                                color={palette.textMuted}
                                size={12}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                            <Text
                                style={[
                                    typography.micro,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Passed
                            </Text>
                        </View>
                    ) : (
                        item.libraryStatus && (
                            <View
                                style={[
                                    styles.libraryBadge,
                                    { backgroundColor: palette.surfaceAlt },
                                ]}
                                accessibilityLabel={`Your status: ${formatLibraryBadge(
                                    item.libraryStatus.status,
                                    item.libraryStatus.rating,
                                )}`}
                            >
                                <Text
                                    style={[
                                        typography.micro,
                                        { color: palette.text },
                                    ]}
                                >
                                    {formatLibraryBadge(
                                        item.libraryStatus.status,
                                        item.libraryStatus.rating,
                                    )}
                                </Text>
                            </View>
                        )
                    )}
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
                <UserLink
                    handle={item.sender.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.sender.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.sender.avatarUrl}
                        displayName={item.sender.displayName}
                        seedId={item.sender.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.sender.handle })
                            }
                        >
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
                <UserLink
                    handle={item.watcher.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.watcher.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.watcher.avatarUrl}
                        displayName={item.watcher.displayName}
                        seedId={item.watcher.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.watcher.handle })
                            }
                        >
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
                <UserLink
                    handle={item.reactor.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.reactor.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.reactor.avatarUrl}
                        displayName={item.reactor.displayName}
                        seedId={item.reactor.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.reactor.handle })
                            }
                        >
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
                <UserLink
                    handle={item.commenter.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.commenter.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.commenter.avatarUrl}
                        displayName={item.commenter.displayName}
                        seedId={item.commenter.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.commenter.handle })
                            }
                        >
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

    function renderRecDeclined(item: RecDeclinedItem) {
        const title = item.titleName ?? 'your recommendation';
        return (
            <Pressable
                onPress={() => router.push(`/rec/${item.recId}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <UserLink
                    handle={item.decliner.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.decliner.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.decliner.avatarUrl}
                        displayName={item.decliner.displayName}
                        seedId={item.decliner.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.decliner.handle })
                            }
                        >
                            {item.decliner.displayName}
                        </Text>{' '}
                        passed on{' '}
                        <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    {item.note ? (
                        <Text
                            style={[
                                typography.caption,
                                styles.note,
                                { color: palette.textMuted },
                            ]}
                            numberOfLines={2}
                        >
                            “{item.note}”
                        </Text>
                    ) : null}
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderRecRequested(item: RecRequestedItem) {
        return (
            <Pressable
                // Untied v1: open the title picker pre-targeted to the
                // requester (library/add forwards preselect → recommend), so
                // the user sends a normal rec back. No request/response link.
                onPress={() =>
                    router.push({
                        pathname: '/library/add',
                        params: { recommendTo: item.requester.userId },
                    })
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <UserLink
                    handle={item.requester.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.requester.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.requester.avatarUrl}
                        displayName={item.requester.displayName}
                        seedId={item.requester.userId}
                        size={AVATAR_SIZE}
                    />
                </UserLink>
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text
                            style={typography.bodyEmphasis}
                            onPress={() =>
                                goToProfile({ handle: item.requester.handle })
                            }
                        >
                            {item.requester.displayName}
                        </Text>{' '}
                        asked you for a recommendation
                    </Text>
                    {item.note ? (
                        <Text
                            style={[
                                typography.caption,
                                styles.note,
                                { color: palette.textMuted },
                            ]}
                            numberOfLines={2}
                        >
                            “{item.note}”
                        </Text>
                    ) : null}
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderRowContent(item: InboxItem) {
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
            case 'notification_rec_declined':
                return renderRecDeclined(item);
            case 'notification_rec_requested':
                return renderRecRequested(item);
        }
    }

    function renderRow({ item }: { item: InboxItem }) {
        const content = renderRowContent(item);
        // Dot shows for unread-informational OR not-yet-actioned-actionable
        // rows. This mirrors the bell badge's source of truth exactly (see
        // use-unread-count.ts) so the two can't drift:
        //   - informational: a notification row that was unread when the
        //     inbox opened this visit. Only notification rows carry a
        //     notificationId; the read-sweep clears read_at on view, so this
        //     dot is gone next visit. (rec_requested is informational too —
        //     it clears on view, matching the badge; no persistent dot.)
        //   - friend_request: present ⇒ still pending (accept/decline delete
        //     the row), so the dot persists until actioned.
        //   - incoming_rec: actionable while recStatus === 'pending' AND the
        //     title isn't in the library (libraryStatus === null) — same rule
        //     the badge uses (status pending minus library membership).
        //     Adding it to the library or watching/dismissing it clears the
        //     dot. Persists across visits (derived from row state, not
        //     read_at). NB: libraryStatus is best-effort (load() logs + nulls
        //     on items-fetch failure), so the dot fails OPEN here where the
        //     badge fails closed — acceptable for a dot.
        const showDot =
            ('notificationId' in item && unreadIds.has(item.notificationId)) ||
            item.kind === 'friend_request' ||
            (item.kind === 'incoming_rec' &&
                item.recStatus === 'pending' &&
                item.libraryStatus === null);
        if (showDot) {
            return (
                <View style={styles.rowWithDot}>
                    {content}
                    <View
                        style={[
                            styles.unreadDot,
                            { backgroundColor: palette.accent },
                        ]}
                        accessibilityLabel="Needs attention"
                        pointerEvents="none"
                    />
                </View>
            );
        }
        return content;
    }

    function renderSentRec({ item }: { item: SentRecItem }) {
        const title = item.titleName ?? 'Untitled';
        return (
            <Pressable
                onPress={() => router.push(`/rec/${item.recId}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                {item.posterPath ? (
                    <Image
                        source={{ uri: imageUrl(item.posterPath, 'w185') }}
                        style={styles.sentPoster}
                        contentFit="cover"
                        transition={150}
                    />
                ) : (
                    <View
                        style={[
                            styles.sentPoster,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    />
                )}
                <View style={styles.rowText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {title}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                        numberOfLines={1}
                    >
                        To{' '}
                        <Text
                            style={{ color: palette.text }}
                            onPress={() =>
                                goToProfile({ handle: item.recipient.handle })
                            }
                        >
                            {item.recipient.displayName}
                        </Text>{' '}
                        (@{item.recipient.handle})
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.sentAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Inbox" showBackButton hideBell />

            {/* Received / Sent toggle — shared SegmentedControl (same
                accentWash treatment as the Library filter zone). Doesn't
                refetch — both lists are already in state, so switching is
                instant. The padded wrapper keeps the control inset from
                the screen edges (it sits on the page bg, not a surfaceAlt
                zone — correct for a solo toggle). */}
            <View style={styles.segmentRow}>
                <SegmentedControl
                    options={INBOX_VIEW_OPTIONS}
                    value={view}
                    onChange={setView}
                    palette={palette}
                />
            </View>

            {showLoader ? (
                <FullScreenLoader />
            ) : error ? (
                <View style={styles.fillCenter}>
                    <Text
                        style={[typography.body, { color: palette.error }]}
                        numberOfLines={3}
                    >
                        {error}
                    </Text>
                </View>
            ) : view === 'received' ? (
                items.length === 0 ? (
                    <View style={styles.fillCenter}>
                        <Text
                            style={[typography.body, { color: palette.textMuted }]}
                            numberOfLines={3}
                        >
                            Nothing here yet. Recs and friend requests will show up
                            when they come in.
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
                                style={[
                                    styles.separator,
                                    { backgroundColor: palette.border },
                                ]}
                            />
                        )}
                    />
                )
            ) : sentItems.length === 0 ? (
                <View style={styles.fillCenter}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={3}
                    >
                        No recs sent yet. Find something to recommend and share it
                        with a friend.
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={sentItems}
                    keyExtractor={(item) => item.id}
                    renderItem={renderSentRec}
                    contentContainerStyle={styles.listContent}
                    ItemSeparatorComponent={() => (
                        <View
                            style={[
                                styles.separator,
                                { backgroundColor: palette.border },
                            ]}
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
    rowWithDot: {
        // Positioning context for the absolute unread dot. No layout of
        // its own — the wrapped row keeps its existing styling.
        position: 'relative',
    },
    unreadDot: {
        // Small accent dot at the trailing edge, vertically centred on the
        // avatar (row paddingVertical + half the avatar). Absolute so it
        // overlays without reflowing the row content.
        position: 'absolute',
        right: spacing.base,
        top: spacing.md + AVATAR_SIZE / 2 - 4,
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    note: {
        fontStyle: 'italic',
    },
    libraryBadge: {
        // Compact pill on the rec card signalling the recipient's
        // existing library status for the rec'd title — "Watched",
        // "Watched · 4★", "Watchlist", "Watching". alignSelf so the
        // pill sizes to its content rather than stretching across
        // the row. rowText's gap: spacing.xs handles vertical
        // spacing from its sibling rows.
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radius.full,
    },
    watchedMarker: {
        // Accent-tinted "Watched" marker for watched recs — check icon +
        // label, distinct from the neutral grey libraryBadge so a watched
        // rec reads as done at a glance. Content-sized pill.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radius.full,
    },
    passedMarker: {
        // Neutral grey "Passed" marker for dismissed recs — same pill
        // shape as watchedMarker but muted (X icon + label) so it reads as
        // settled/declined, not an active ask and not a "done & liked".
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radius.full,
    },
    rowDimmed: {
        // Greys the whole passed-rec row so it recedes from the active
        // pending/watched items while staying legible and tappable.
        opacity: 0.55,
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
    segmentRow: {
        // Inset wrapper around the shared SegmentedControl — keeps it off
        // the screen edges and spaced from the header / list below.
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
    },
    sentPoster: {
        width: SENT_POSTER_WIDTH,
        height: SENT_POSTER_HEIGHT,
        borderRadius: radius.sm,
    },
});
