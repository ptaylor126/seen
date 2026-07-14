import type { SupabaseClient } from '@supabase/supabase-js';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { CheckCircle, XCircle } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    AppState,
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
import {
    WatchersSheet,
    type WatcherSheetItem,
} from '@/components/watchers-sheet';
import { goToChatAboutTitle, quickSendAboutTitle } from '@/lib/chat-nav';
import { getSentChats } from '@/lib/chats';
import {
    getFriendsWhoWatched,
    getFriendsWhoWatchedByTitle,
} from '@/lib/friend-activity';
import { formatLibraryBadge, type ItemStatus } from '@/lib/item-status';
import { goToProfile } from '@/lib/profile-nav';
import { promptPushAtHighIntent } from '@/lib/push';
import { formatRatingStars } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { imageUrl } from '@/lib/tmdb';
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
    // The rec the watch happened on — tapping opens its thread, same as
    // rec_commented / rec_reacted. tmdbId/mediaType stay for the title label.
    recId: string | null;
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

interface RecClaimedItem {
    kind: 'notification_rec_claimed';
    id: string;
    createdAt: string;
    notificationId: string;
    // The person who joined Seen from the sender's rec invite.
    claimer: ProfileSummary;
    recId: string | null;
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

// Someone reacted (with an emoji) to a COMMENT the current user left on a
// rec — distinct from rec_reacted (a reaction on the rec itself). Tapping
// opens the rec the comment lives on, same as rec_commented.
interface CommentReactedItem {
    kind: 'notification_comment_reacted';
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
    // The comment came from the post-watched sheet → the row reads "watched"
    // instead of "commented" (the wording is the only difference).
    fromWatched: boolean;
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

// Fallback for a counted notification whose payload can't build its normal
// row (missing recommendation_id, or a kind with no specific renderer). We
// render a generic "interacted with your rec" row instead of skipping it, so
// no bell-counted notification is ever silently dropped from the list. Taps
// through to the rec when a recommendation_id is present, otherwise inert.
interface GenericActivityItem {
    kind: 'notification_generic';
    id: string;
    createdAt: string;
    notificationId: string;
    actor: ProfileSummary;
    recId: string | null;
}

// "Chat about a title" notifications — same row anatomy as the rec kinds
// (actor + title + timestamp, tap into the thread) with chat voice. All
// three route to /chat/{chatId}.
interface ChatCommentedItem {
    kind: 'notification_chat_commented';
    id: string;
    createdAt: string;
    notificationId: string;
    sender: ProfileSummary;
    chatId: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
    // True for the OLDEST chat_commented we fetched for this chat — rendered
    // as "wants to chat about" (the invite); later messages read as plain
    // messages. Heuristic: the true first message's notification can age out
    // of the capped read fetch, promoting a later one — harmless.
    isOpener: boolean;
}

interface ChatReactedItem {
    kind: 'notification_chat_reacted';
    id: string;
    createdAt: string;
    notificationId: string;
    reactor: ProfileSummary;
    chatId: string;
    emoji: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
}

interface ChatCommentReactedItem {
    kind: 'notification_chat_comment_reacted';
    id: string;
    createdAt: string;
    notificationId: string;
    reactor: ProfileSummary;
    chatId: string;
    emoji: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
}

// "{name} has seen {title}" — the quiet overlap row (chat-about-it 3b).
// Ambient/informational: forward rows arrive pre-read (the user saw the
// banner); reverse rows arrive unread and dot via the normal snapshot, but
// the kind is excluded from unread_count so it never inflates the bell.
// Tap → the watcher-picker for the title.
interface WatchlistOverlapItem {
    kind: 'notification_watchlist_overlap';
    id: string;
    createdAt: string;
    notificationId: string;
    // First watcher in the payload set leads the copy; the second is named
    // too when there are exactly two ("{name} and {name} have seen {title}").
    // The picker fetches the fresh full list on tap.
    leadWatcher: ProfileSummary;
    secondWatcher: ProfileSummary | null;
    watcherCount: number;
    tmdbId: number | null;
    mediaType: MediaType | null;
    titleName: string | null;
    posterPath: string | null;
}

type InboxItem =
    | IncomingRecItem
    | FriendRequestItem
    | RecWatchedItem
    | FriendAcceptedItem
    | RecClaimedItem
    | RecReactedItem
    | CommentReactedItem
    | RecCommentedItem
    | RecDeclinedItem
    | RecRequestedItem
    | ChatCommentedItem
    | ChatReactedItem
    | ChatCommentReactedItem
    | WatchlistOverlapItem
    | GenericActivityItem;

// Sent recs are NOT unioned into InboxItem — different render path, no
// notification semantics, no badge effects. Multi-recipient sends create
// one recommendations row per recipient, which surfaces here as one row
// per recipient by design (no grouping by title).
interface SentRecItem {
    kind: 'sent_rec';
    id: string;
    sentAt: string;
    recId: string;
    tmdbId: number;
    mediaType: MediaType;
    titleName: string | null;
    posterPath: string | null;
    recipient: ProfileSummary;
}

// A chat the current user STARTED (title_chats.from_user_id = me) — shown in
// Sent alongside sent recs, with chat framing. Tap opens the thread.
interface SentChatItem {
    kind: 'sent_chat';
    id: string;
    sentAt: string;
    chatId: string;
    tmdbId: number;
    mediaType: MediaType;
    titleName: string | null;
    posterPath: string | null;
    recipient: ProfileSummary;
}

type SentItem = SentRecItem | SentChatItem;

// titleByKey holds title + poster path so Sent rows can render a poster
// thumbnail. Received call sites only read .title — they're updated in
// place to use .title ?? null.
interface TitleMeta {
    title: string | null;
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

// The notification kinds the inbox renders — used by BOTH the unread
// (uncapped) and read (capped) notification fetches so they stay in lockstep.
// unread_count counts every kind except rec_received; each of these has a
// renderer (or falls back to the generic row), so bell and list agree.
const RENDER_KINDS = [
    'rec_watched',
    'friend_accepted',
    'rec_claimed',
    'rec_reacted',
    'comment_reacted',
    'rec_commented',
    'rec_declined',
    'rec_requested',
    'chat_commented',
    'chat_reacted',
    'chat_comment_reacted',
    'watchlist_overlap',
] as const;

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

// Appends the episode coordinate to a chat's title so an episode chat reads
// "{title} · S2 E5" and is distinguishable from a whole-show chat about the
// same title. Whole-show chats (season/episode null) are returned unchanged.
function withEpisodeSuffix(
    name: string | null,
    scope: { season: number | null; episode: number | null } | undefined,
): string | null {
    if (!name || !scope || scope.season === null || scope.episode === null) {
        return name;
    }
    return `${name} · S${scope.season} E${scope.episode}`;
}

function pickString(payload: Record<string, unknown> | null, key: string): string | null {
    const v = payload?.[key];
    return typeof v === 'string' ? v : null;
}

function pickNumber(payload: Record<string, unknown> | null, key: string): number | null {
    const v = payload?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickBoolean(payload: Record<string, unknown> | null, key: string): boolean {
    return payload?.[key] === true;
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
    // Pushed screen (no floating tab bar) — pad the lists clear of the nav bar.
    const bottomInset = useBottomInset(spacing.lg);

    const [items, setItems] = useState<InboxItem[]>([]);
    const [sentItems, setSentItems] = useState<SentItem[]>([]);
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
    // Watcher-picker behind an overlap row tap — fetched fresh per tap.
    // Carries the title (name + poster) so the sheet can show a tappable
    // title header through to the title page alongside the picker.
    const [overlapPicker, setOverlapPicker] = useState<{
        tmdbId: number;
        mediaType: MediaType;
        watchers: WatcherSheetItem[];
        titleName: string | null;
        posterPath: string | null;
    } | null>(null);

    // Show the full loading state only on the FIRST load (mount/focus). Later
    // re-runs — navigation-focus refocus, and especially the AppState 'active'
    // foreground refetch — update the list in place with no spinner flash,
    // mirroring use-unread-count's silent refresh. Flipped true on first success
    // so a failed first load still shows the spinner on retry.
    const hasLoadedOnce = useRef(false);
    const load = useCallback(async () => {
        if (!hasLoadedOnce.current) setLoading(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // All read sources in one batch. The three the bell counts —
            // pending recs, friend requests, UNREAD notifications — are fetched
            // UNCAPPED so nothing counted can fall outside the window. History
            // (watched/dismissed recs, READ notifications) is windowed to
            // MAX_ITEMS; it's not countable, so a cap can't strand a counted
            // item. The Sent query is unconditional so flipping to the Sent tab
            // is instant. NB: the mark-read sweep does NOT run here — it runs
            // only AFTER these reads resolve (see below), so the unread fetch
            // can't race the write that clears read_at.
            const [
                pendingRecsResult,
                historyRecsResult,
                requestsResult,
                unreadNotifsResult,
                readNotifsResult,
                sentRecsResult,
                sentChats,
            ] = await Promise.all([
                // Pending recs — UNCAPPED. The bell counts this exact set, so
                // any cap re-creates a counted-but-unreachable class at cap+1.
                // Self-limiting (acting on a rec removes it from 'pending').
                supabase
                    .from('recommendations')
                    .select(
                        'id, from_user_id, tmdb_id, media_type, note, sent_at, status',
                    )
                    .eq('to_user_id', userId)
                    .eq('status', 'pending')
                    .order('sent_at', { ascending: false }),
                // History recs = watched + dismissed only. Recency-windowed:
                // not countable, grows forever, doesn't need to be exhaustively
                // reachable. A watched rec stays (post-watch conversation lives
                // on it); a dismissed ("passed") rec stays greyed.
                supabase
                    .from('recommendations')
                    .select(
                        'id, from_user_id, tmdb_id, media_type, note, sent_at, status',
                    )
                    .eq('to_user_id', userId)
                    .in('status', ['watched', 'dismissed'])
                    .order('sent_at', { ascending: false })
                    .limit(MAX_ITEMS),
                // Friend requests — UNCAPPED. friend_requests has no status
                // column: a row exists iff pending (accept/decline deletes it),
                // and every row is bell-counted, so no limit.
                supabase
                    .from('friend_requests')
                    .select('id, from_user_id, created_at')
                    .eq('to_user_id', userId)
                    .order('created_at', { ascending: false }),
                // Unread notifications — UNCAPPED. Bell-counted (kind <>
                // rec_received); fetching all of them guarantees the sweep
                // below can't clear one we never showed. Also the per-visit
                // unread-dot source.
                supabase
                    .from('notifications')
                    .select('id, kind, payload, created_at')
                    .eq('user_id', userId)
                    .is('read_at', null)
                    .in('kind', RENDER_KINDS)
                    .order('created_at', { ascending: false }),
                // Read notifications — history, capped. Not countable.
                supabase
                    .from('notifications')
                    .select('id, kind, payload, created_at')
                    .eq('user_id', userId)
                    .not('read_at', 'is', null)
                    .in('kind', RENDER_KINDS)
                    .order('created_at', { ascending: false })
                    .limit(MAX_ITEMS),
                // Sent recs — one row per (title, recipient) by construction.
                supabase
                    .from('recommendations')
                    .select('id, to_user_id, tmdb_id, media_type, sent_at')
                    .eq('from_user_id', userId)
                    .order('sent_at', { ascending: false })
                    .limit(MAX_ITEMS),
                // Chats the user started — merged into Sent alongside sent
                // recs (chat framing). One per (pair, title) by construction.
                getSentChats(userId, MAX_ITEMS),
            ]);

            if (pendingRecsResult.error) throw pendingRecsResult.error;
            if (historyRecsResult.error) throw historyRecsResult.error;
            if (requestsResult.error) throw requestsResult.error;
            if (unreadNotifsResult.error) throw unreadNotifsResult.error;
            if (readNotifsResult.error) throw readNotifsResult.error;
            if (sentRecsResult.error) throw sentRecsResult.error;

            // Mark-read sweep — runs ONLY after the reads above resolve, so the
            // unread fetch can't race the write (read-before-sweep). The reads
            // have already resolved here, so fire it WITHOUT awaiting: it's a
            // write we don't need before rendering, and keeping it off the
            // critical path shaves a round-trip off the loader. Best-effort:
            // a sweep failure leaves read_at intact (dots reappear next visit)
            // but never breaks the list.
            void supabase
                .from('notifications')
                .update({ read_at: new Date().toISOString() })
                .eq('user_id', userId)
                .is('read_at', null)
                .then(({ error: markReadError }) => {
                    if (markReadError) {
                        console.warn('inbox mark-read sweep failed:', markReadError);
                    }
                });

            const unreadNotifs = unreadNotifsResult.data ?? [];
            const readNotifs = readNotifsResult.data ?? [];
            // Per-visit unread-dot source: the rows unread at load (pre-sweep).
            const unreadSnapshot = new Set(unreadNotifs.map((n) => n.id));
            // Combined notification feed: unread (uncapped) + read (capped).
            // Disjoint by read_at (both read before the sweep), but deduped by
            // id defensively so a concurrent write can't double a row.
            const seenNotifIds = new Set<string>();
            const notifications: typeof unreadNotifs = [];
            for (const n of [...unreadNotifs, ...readNotifs]) {
                if (seenNotifIds.has(n.id)) continue;
                seenNotifIds.add(n.id);
                notifications.push(n);
            }

            // Combined received recs for the shared hydration batches
            // (profiles, titles, library statuses).
            const recs = [
                ...(pendingRecsResult.data ?? []),
                ...(historyRecsResult.data ?? []),
            ];
            const requests = requestsResult.data ?? [];
            const sentRecs = sentRecsResult.data ?? [];

            // LIVE watchers per overlap row, via the shared
            // getFriendsWhoWatchedByTitle — ONE rule for "who watched this"
            // (payload.watcher_ids is a stale snapshot the client no longer
            // reads for display). The notification ROW is a "who to talk to
            // about this" prompt, so we DROP flagged watchers (a friend who
            // recommended it to me is noise here). The picker behind the row
            // keeps everyone (see handleOverlapTap). Keyed
            // `${media_type}:${tmdb_id}`; most-recent watcher first.
            const overlapWatchersByKey = new Map<string, string[]>();
            {
                const overlapTmdbIds = notifications
                    .filter((n) => n.kind === 'watchlist_overlap')
                    .map((n) => pickNumber(asRecord(n.payload), 'tmdb_id'))
                    .filter((id): id is number => id !== null);
                if (overlapTmdbIds.length > 0) {
                    const byKey = await getFriendsWhoWatchedByTitle(
                        userId,
                        overlapTmdbIds,
                    );
                    for (const [key, entries] of byKey) {
                        overlapWatchersByKey.set(
                            key,
                            entries
                                .filter((e) => !e.recommendedToMe)
                                .map((e) => e.userId),
                        );
                    }
                }
            }

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
            for (const c of sentChats) {
                otherUserIds.add(c.toUserId);
            }
            for (const n of notifications) {
                const payload = asRecord(n.payload);
                // rec_watched carries the watcher as to_user_id; every other
                // kind (and the generic fallback) resolves its actor from
                // from_user_id. Collecting generically means the fallback row
                // and any future kind still get a resolved profile.
                const id =
                    n.kind === 'rec_watched'
                        ? pickString(payload, 'to_user_id')
                        : pickString(payload, 'from_user_id');
                if (id) otherUserIds.add(id);
                // watchlist_overlap has no single actor — its lead watcher
                // fronts the row copy, and the second is named in the
                // two-watcher wording. Resolve both from the LIVE set (not
                // the stale payload watcher_ids).
                if (n.kind === 'watchlist_overlap') {
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    const live =
                        mt && tid
                            ? overlapWatchersByKey.get(`${mt}:${tid}`) ?? []
                            : [];
                    if (live[0]) otherUserIds.add(live[0]);
                    if (live[1]) otherUserIds.add(live[1]);
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

            // Title + poster metadata for incoming recs, sent recs, and
            // title-bearing notifications. ONE batched query against the shared
            // public.titles catalogue (fetchTitlesByItems) instead of a
            // getMovie/getTV fan-out — the previous per-title Edge round-trips
            // were the inbox's dominant load cost. Missing key → the same
            // undefined-lookup fallback as before ('this title' / null poster).
            type TitleKey = string; // `${mediaType}:${tmdbId}`
            const titleItems = new Map<
                TitleKey,
                { tmdb_id: number; media_type: string }
            >();
            const addTitleItem = (media_type: string, tmdb_id: number) => {
                titleItems.set(`${media_type}:${tmdb_id}`, {
                    tmdb_id,
                    media_type,
                });
            };
            for (const r of recs) addTitleItem(r.media_type, r.tmdb_id);
            for (const r of sentRecs) addTitleItem(r.media_type, r.tmdb_id);
            for (const c of sentChats) addTitleItem(c.mediaType, c.tmdbId);
            for (const n of notifications) {
                if (
                    n.kind !== 'rec_watched' &&
                    n.kind !== 'rec_reacted' &&
                    n.kind !== 'comment_reacted' &&
                    n.kind !== 'rec_commented' &&
                    n.kind !== 'rec_declined' &&
                    n.kind !== 'chat_commented' &&
                    n.kind !== 'chat_reacted' &&
                    n.kind !== 'chat_comment_reacted' &&
                    n.kind !== 'watchlist_overlap'
                ) {
                    continue;
                }
                const payload = asRecord(n.payload);
                const mt = pickMediaType(payload, 'media_type');
                const tid = pickNumber(payload, 'tmdb_id');
                if (mt && tid) addTitleItem(mt, tid);
            }

            const titleByKey = new Map<TitleKey, TitleMeta>();
            if (titleItems.size > 0) {
                const catalogByKey = await fetchTitlesByItems(
                    Array.from(titleItems.values()),
                );
                for (const [key, row] of catalogByKey) {
                    titleByKey.set(key, {
                        title: row.title,
                        posterPath: row.poster_path,
                    });
                }
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

            // Build a generic activity row from a notification whose normal
            // renderer can't be satisfied — missing recommendation_id, or an
            // unhandled kind. Renders instead of skipping so no bell-counted
            // notification is ever silently dropped (count and list agree).
            const buildGeneric = (
                n: (typeof notifications)[number],
            ): GenericActivityItem => {
                const p = asRecord(n.payload);
                const actorId = pickString(p, 'from_user_id');
                return {
                    kind: 'notification_generic',
                    id: `notif:${n.id}`,
                    createdAt: n.created_at,
                    notificationId: n.id,
                    actor: actorId
                        ? profilesById.get(actorId) ?? placeholderProfile
                        : placeholderProfile,
                    recId: pickString(p, 'recommendation_id'),
                };
            };

            // The chat "opener" — the OLDEST chat_commented we fetched per
            // chat_id — renders as "wants to chat about" (the invite); later
            // messages read as plain messages. Window heuristic: if the true
            // first message's notification has aged out of the capped read
            // fetch, the oldest-in-window is promoted — harmless.
            const chatOpenerNotifIds = new Set<string>();
            {
                const oldestByChat = new Map<
                    string,
                    { id: string; createdAt: string }
                >();
                for (const n of notifications) {
                    if (n.kind !== 'chat_commented') continue;
                    const chatId = pickString(asRecord(n.payload), 'chat_id');
                    if (!chatId) continue;
                    const current = oldestByChat.get(chatId);
                    if (!current || n.created_at < current.createdAt) {
                        oldestByChat.set(chatId, {
                            id: n.id,
                            createdAt: n.created_at,
                        });
                    }
                }
                for (const v of oldestByChat.values()) {
                    chatOpenerNotifIds.add(v.id);
                }
            }

            // Exact chat-CREATOR lookup for chat_commented rows: who STARTED
            // each chat (title_chats.from_user_id). A message in a chat *I*
            // created is a REPLY, never an invite — so it must never read as
            // "wants to chat", regardless of which notification is oldest in
            // the window. Keyed on chat_id (window-independent, unlike the
            // sent-chats cap); a party may read title_chats under RLS.
            const chatCreatorById = new Map<string, string>();
            // Episode scope per chat (season/episode), so an episode chat reads
            // "· S2 E5" in the inbox and is distinguishable from a whole-show
            // chat about the same title. Same batched read as the creator map.
            const chatEpisodeById = new Map<
                string,
                { season: number | null; episode: number | null }
            >();
            {
                const chatIds = Array.from(
                    new Set(
                        notifications
                            .filter(
                                (n) =>
                                    n.kind === 'chat_commented' ||
                                    n.kind === 'chat_reacted' ||
                                    n.kind === 'chat_comment_reacted',
                            )
                            .map((n) =>
                                pickString(asRecord(n.payload), 'chat_id'),
                            )
                            .filter((id): id is string => !!id),
                    ),
                );
                if (chatIds.length > 0) {
                    // reason: title_chats isn't in the generated Database
                    // types yet, so query through an untyped client (same
                    // pattern as src/lib/chats.ts).
                    const { data: chatRows, error: chatRowsError } =
                        await (supabase as unknown as SupabaseClient)
                            .from('title_chats')
                            .select('id, from_user_id, season, episode')
                            .in('id', chatIds);
                    if (chatRowsError) throw chatRowsError;
                    for (const c of (chatRows ?? []) as Array<{
                        id: string;
                        from_user_id: string | null;
                        season: number | null;
                        episode: number | null;
                    }>) {
                        if (c.from_user_id) {
                            chatCreatorById.set(c.id, c.from_user_id);
                        }
                        chatEpisodeById.set(c.id, {
                            season: c.season ?? null,
                            episode: c.episode ?? null,
                        });
                    }
                }
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
                        recId: pickString(payload, 'recommendation_id'),
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
                } else if (n.kind === 'rec_claimed') {
                    // Someone joined Seen by claiming this user's rec
                    // invite. payload.from_user_id is the claimer (the
                    // generic actor-collection pass above resolved their
                    // profile); recommendation_id routes to the rec the
                    // claim created.
                    const claimerId = pickString(payload, 'from_user_id');
                    const claimer = claimerId
                        ? profilesById.get(claimerId) ?? placeholderProfile
                        : placeholderProfile;
                    inboxItems.push({
                        kind: 'notification_rec_claimed',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        claimer,
                        recId: pickString(payload, 'recommendation_id'),
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
                    if (!recId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
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
                } else if (n.kind === 'comment_reacted') {
                    // Reaction on the user's COMMENT (not the rec itself).
                    // Same payload shape as rec_reacted plus comment_id (unused
                    // here — we navigate to the rec, not the comment).
                    const reactorId = pickString(payload, 'from_user_id');
                    const reactor = reactorId
                        ? profilesById.get(reactorId) ?? placeholderProfile
                        : placeholderProfile;
                    const recId = pickString(payload, 'recommendation_id');
                    const emoji = pickString(payload, 'emoji') ?? '';
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!recId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
                    inboxItems.push({
                        kind: 'notification_comment_reacted',
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
                    if (!recId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
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
                        fromWatched: pickBoolean(payload, 'from_watched'),
                    });
                } else if (n.kind === 'rec_declined') {
                    const declinerId = pickString(payload, 'from_user_id');
                    const decliner = declinerId
                        ? profilesById.get(declinerId) ?? placeholderProfile
                        : placeholderProfile;
                    const recId = pickString(payload, 'recommendation_id');
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!recId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
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
                    if (!requesterId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
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
                } else if (n.kind === 'chat_commented') {
                    const senderId = pickString(payload, 'from_user_id');
                    const chatId = pickString(payload, 'chat_id');
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!chatId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
                    inboxItems.push({
                        kind: 'notification_chat_commented',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        sender: senderId
                            ? profilesById.get(senderId) ?? placeholderProfile
                            : placeholderProfile,
                        chatId,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName: withEpisodeSuffix(
                            mt && tid
                                ? titleByKey.get(`${mt}:${tid}`)?.title ?? null
                                : null,
                            chatEpisodeById.get(chatId),
                        ),
                        // "wants to chat" ONLY when the OTHER party started
                        // the chat (creator ≠ me) AND this is its opening
                        // message; a chat I created reads as their reply.
                        isOpener:
                            chatOpenerNotifIds.has(n.id) &&
                            chatCreatorById.get(chatId) !== userId,
                    });
                } else if (
                    n.kind === 'chat_reacted' ||
                    n.kind === 'chat_comment_reacted'
                ) {
                    const reactorId = pickString(payload, 'from_user_id');
                    const chatId = pickString(payload, 'chat_id');
                    const emoji = pickString(payload, 'emoji') ?? '';
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!chatId) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
                    inboxItems.push({
                        kind:
                            n.kind === 'chat_reacted'
                                ? 'notification_chat_reacted'
                                : 'notification_chat_comment_reacted',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        reactor: reactorId
                            ? profilesById.get(reactorId) ?? placeholderProfile
                            : placeholderProfile,
                        chatId,
                        emoji,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName: withEpisodeSuffix(
                            mt && tid
                                ? titleByKey.get(`${mt}:${tid}`)?.title ?? null
                                : null,
                            chatEpisodeById.get(chatId),
                        ),
                    });
                } else if (n.kind === 'watchlist_overlap') {
                    const mt = pickMediaType(payload, 'media_type');
                    const tid = pickNumber(payload, 'tmdb_id');
                    if (!mt || !tid) {
                        inboxItems.push(buildGeneric(n));
                        continue;
                    }
                    // Display from the LIVE watcher set (payload keeps its
                    // role as the dedup key + "why the row exists", but is
                    // no longer the display source). Edge: zero currently-
                    // visible watchers → suppress the row; it has nothing
                    // true left to say (overlaps are excluded from the bell
                    // count, so nothing is orphaned).
                    const liveIds =
                        overlapWatchersByKey.get(`${mt}:${tid}`) ?? [];
                    if (liveIds.length === 0) {
                        continue;
                    }
                    inboxItems.push({
                        kind: 'notification_watchlist_overlap',
                        id: `notif:${n.id}`,
                        createdAt: n.created_at,
                        notificationId: n.id,
                        leadWatcher:
                            profilesById.get(liveIds[0]) ?? placeholderProfile,
                        secondWatcher: liveIds[1]
                            ? profilesById.get(liveIds[1]) ?? placeholderProfile
                            : null,
                        watcherCount: liveIds.length,
                        tmdbId: tid,
                        mediaType: mt,
                        titleName:
                            titleByKey.get(`${mt}:${tid}`)?.title ?? null,
                        posterPath:
                            titleByKey.get(`${mt}:${tid}`)?.posterPath ?? null,
                    });
                } else {
                    // Unhandled kind — the query filters to RENDER_KINDS so
                    // this shouldn't fire, but future-proof: render the
                    // fallback rather than drop a counted notification.
                    inboxItems.push(buildGeneric(n));
                }
            }

            // Single chronological list. Everything COUNTABLE (pending recs,
            // friend requests, unread notifications) is already present via its
            // uncapped fetch and is always shown at its chronological position.
            // HISTORY (watched/dismissed recs, read notifications, and any
            // fallback built from a read notif) is merged, sorted, and windowed
            // to MAX_ITEMS on its own — capping only the non-countable set so
            // nothing the bell counts can fall out. The two sets are then
            // combined, deduped by composed id, and sorted newest-first: no
            // grouping, no headers, no final slice. The per-row dot carries the
            // "needs attention" signal (a pending rec keeps its dot until
            // actioned, wherever it sorts).
            const isHistory = (it: InboxItem): boolean => {
                if (it.kind === 'incoming_rec') return it.recStatus !== 'pending';
                if (it.kind === 'friend_request') return false;
                // Notification-derived rows (incl. the generic fallback):
                // history iff already read at load (not in the pre-sweep
                // unread snapshot).
                if ('notificationId' in it) {
                    return !unreadSnapshot.has(it.notificationId);
                }
                return false;
            };
            const byNewest = (a: InboxItem, b: InboxItem) =>
                b.createdAt.localeCompare(a.createdAt);
            const countableItems = inboxItems.filter((it) => !isHistory(it));
            const historyItems = inboxItems
                .filter(isHistory)
                .sort(byNewest)
                .slice(0, MAX_ITEMS);
            const seenIds = new Set<string>();
            const merged: InboxItem[] = [];
            for (const it of [...countableItems, ...historyItems]) {
                if (seenIds.has(it.id)) continue;
                seenIds.add(it.id);
                merged.push(it);
            }
            merged.sort(byNewest);
            setItems(merged);
            // Apply the open-time snapshot alongside the rows so the dots
            // appear with this visit's data.
            setUnreadIds(unreadSnapshot);

            // Sent items. Query is already ordered newest-first, so a
            // second sort is redundant — but keep it defensive in case
            // recipient hydration ever reshuffles. Recipient profile is
            // ALWAYS resolvable for sent rows: to_user_id is non-null
            // per schema, and friends are RLS-readable; missing profile
            // means the recipient was deleted.
            const sentList: SentItem[] = [];
            for (const r of sentRecs) {
                const meta = titleByKey.get(`${r.media_type}:${r.tmdb_id}`);
                const recipient =
                    profilesById.get(r.to_user_id) ?? {
                        ...placeholderProfile,
                        displayName: 'Former user',
                    };
                sentList.push({
                    kind: 'sent_rec',
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
            // Chats the user started, merged in with chat framing. Both
            // source queries are newest-first; the combined sort interleaves
            // them chronologically before the window.
            for (const c of sentChats) {
                const meta = titleByKey.get(`${c.mediaType}:${c.tmdbId}`);
                const recipient =
                    profilesById.get(c.toUserId) ?? {
                        ...placeholderProfile,
                        displayName: 'Former user',
                    };
                sentList.push({
                    kind: 'sent_chat',
                    id: `sentchat:${c.id}`,
                    sentAt: c.createdAt,
                    chatId: c.id,
                    tmdbId: c.tmdbId,
                    mediaType: c.mediaType,
                    titleName: withEpisodeSuffix(meta?.title ?? null, {
                        season: c.season,
                        episode: c.episode,
                    }),
                    posterPath: meta?.posterPath ?? null,
                    recipient,
                });
            }
            sentList.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
            setSentItems(sentList.slice(0, MAX_ITEMS));
            // First successful load done → subsequent re-runs refresh silently.
            hasLoadedOnce.current = true;
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

    // App-foreground fallback: useFocusEffect only fires on navigation focus.
    // It does NOT fire when the OS brings the app back from background with the
    // inbox still the focused screen — e.g. tapping a push banner that
    // foregrounds onto the already-open inbox — so a just-arrived notification
    // would stay missing until the user navigated away and back. Reloading on
    // AppState 'active' closes that gap. Mirrors use-unread-count.tsx (which
    // does the same for the bell count).
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                void load();
            }
        });
        return () => sub.remove();
    }, [load]);

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
                await promptPushAtHighIntent(session.user.id);
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
        // Tap → the rec thread (rec detail for this recommendation_id), matching
        // rec_commented / rec_reacted — where the watch's comment/rating lives.
        const canNavigate = !!item.recId;
        return (
            <Pressable
                onPress={() => {
                    if (canNavigate) {
                        router.push(`/rec/${item.recId}`);
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

    function renderRecClaimed(item: RecClaimedItem) {
        return (
            <Pressable
                onPress={() =>
                    item.recId
                        ? router.push(`/rec/${item.recId}`)
                        : router.push(`/friends/${item.claimer.handle}`)
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Avatar
                    avatarUrl={item.claimer.avatarUrl}
                    displayName={item.claimer.displayName}
                    seedId={item.claimer.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        <Text style={typography.bodyEmphasis}>
                            {item.claimer.displayName}
                        </Text>{' '}
                        joined Seen from your rec
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

    function renderCommentReacted(item: CommentReactedItem) {
        const title = item.titleName ?? 'your rec';
        return (
            <Pressable
                // Tap → the rec the comment lives on, same as rec_commented.
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
                        reacted {item.emoji} to your comment on{' '}
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
                        {item.fromWatched ? 'watched' : 'commented on'}{' '}
                        <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    // Chat notifications — same row anatomy as the rec kinds, chat voice.
    // The opener (first fetched message per chat) reads as the invite.
    function renderChatCommented(item: ChatCommentedItem) {
        const title = item.titleName ?? 'a title';
        return (
            <Pressable
                onPress={() => router.push(`/chat/${item.chatId}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
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
                        {item.isOpener
                            ? 'wants to chat about'
                            : 'sent a message about'}{' '}
                        <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    function renderChatReacted(item: ChatReactedItem | ChatCommentReactedItem) {
        const title = item.titleName ?? 'a title';
        // chat_reacted = a reaction on the chat itself; chat_comment_reacted
        // = a reaction on one of your messages in it. Both open the thread.
        const target =
            item.kind === 'notification_chat_reacted'
                ? 'your chat about'
                : 'your message about';
        return (
            <Pressable
                onPress={() => router.push(`/chat/${item.chatId}`)}
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
                        reacted {item.emoji} to {target}{' '}
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

    // Fallback row for a counted notification whose normal renderer couldn't
    // be built (malformed payload / unhandled kind). Reads generically and
    // taps to the rec when a recommendation_id survived, otherwise inert.
    function renderGenericActivity(item: GenericActivityItem) {
        const canNavigate = item.recId !== null;
        return (
            <Pressable
                onPress={() => {
                    if (canNavigate) router.push(`/rec/${item.recId}`);
                }}
                disabled={!canNavigate}
                style={({ pressed }) => [
                    styles.row,
                    pressed && canNavigate && { opacity: 0.6 },
                ]}
            >
                <UserLink
                    handle={item.actor.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${item.actor.displayName}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.actor.avatarUrl}
                        displayName={item.actor.displayName}
                        seedId={item.actor.userId}
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
                                goToProfile({ handle: item.actor.handle })
                            }
                        >
                            {item.actor.displayName}
                        </Text>{' '}
                        interacted with your rec
                    </Text>
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
            case 'notification_rec_claimed':
                return renderRecClaimed(item);
            case 'notification_rec_reacted':
                return renderRecReacted(item);
            case 'notification_comment_reacted':
                return renderCommentReacted(item);
            case 'notification_rec_commented':
                return renderRecCommented(item);
            case 'notification_rec_declined':
                return renderRecDeclined(item);
            case 'notification_rec_requested':
                return renderRecRequested(item);
            case 'notification_chat_commented':
                return renderChatCommented(item);
            case 'notification_chat_reacted':
            case 'notification_chat_comment_reacted':
                return renderChatReacted(item);
            case 'notification_watchlist_overlap':
                return renderWatchlistOverlap(item);
            case 'notification_generic':
                return renderGenericActivity(item);
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

    // Quiet overlap row — ambient voice, no action framing. Tap fetches the
    // fresh watcher list and opens the picker (the payload's set can be
    // stale; the fetch re-applies the privacy contract at read time).
    function renderWatchlistOverlap(item: WatchlistOverlapItem) {
        const title = item.titleName ?? 'a title';
        const name = item.leadWatcher.displayName;
        // Names while they fit: one → "{name} has seen"; exactly two → both
        // names; three+ → "{name} and N others". ("and 1 other" is broken
        // grammar.)
        const useTwoNames = item.watcherCount === 2 && item.secondWatcher;
        return (
            <Pressable
                onPress={() => void handleOverlapTap(item)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <UserLink
                    handle={item.leadWatcher.handle}
                    hitSlop={8}
                    accessibilityLabel={`View ${name}'s profile`}
                >
                    <Avatar
                        avatarUrl={item.leadWatcher.avatarUrl}
                        displayName={name}
                        seedId={item.leadWatcher.userId}
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
                                goToProfile({ handle: item.leadWatcher.handle })
                            }
                        >
                            {name}
                        </Text>
                        {useTwoNames && item.secondWatcher ? (
                            <>
                                {' and '}
                                <Text
                                    style={typography.bodyEmphasis}
                                    onPress={() =>
                                        goToProfile({
                                            handle: item.secondWatcher!.handle,
                                        })
                                    }
                                >
                                    {item.secondWatcher.displayName}
                                </Text>
                                {' have seen '}
                            </>
                        ) : item.watcherCount >= 3 ? (
                            ` and ${item.watcherCount - 1} others have seen `
                        ) : (
                            ' has seen '
                        )}
                        <Text style={typography.bodyEmphasis}>{title}</Text>
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {relativeTimestamp(item.createdAt)}
                    </Text>
                </View>
            </Pressable>
        );
    }

    // Overlap row tap → fresh watcher fetch → picker sheet. Fetch-first so
    // the sheet never opens empty-then-fills; failure = no sheet (the row
    // stays tappable to retry).
    async function handleOverlapTap(item: WatchlistOverlapItem) {
        if (!item.tmdbId || !item.mediaType) return;
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const uid = session?.user.id;
            if (!uid) return;
            const watchers = await getFriendsWhoWatched(
                uid,
                item.tmdbId,
                item.mediaType,
            );
            setOverlapPicker({
                tmdbId: item.tmdbId,
                mediaType: item.mediaType,
                watchers,
                titleName: item.titleName,
                posterPath: item.posterPath,
            });
        } catch (err) {
            console.warn('overlap picker fetch failed:', err);
        }
    }

    // One renderer for both Sent kinds — identical row anatomy (poster,
    // title, recipient, timestamp); the framing line and tap target differ:
    // recs read "To {name}" and open the rec thread, chats read "Chat with
    // {name}" and open the chat thread.
    function renderSentItem({ item }: { item: SentItem }) {
        const title = item.titleName ?? 'Untitled';
        return (
            <Pressable
                onPress={() =>
                    item.kind === 'sent_rec'
                        ? router.push(`/rec/${item.recId}`)
                        : router.push(`/chat/${item.chatId}`)
                }
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
                        {item.kind === 'sent_rec' ? 'To' : 'Chat with'}{' '}
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
                        contentContainerStyle={[
                            styles.listContent,
                            { paddingBottom: bottomInset },
                        ]}
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
                    renderItem={renderSentItem}
                    contentContainerStyle={[
                        styles.listContent,
                        { paddingBottom: bottomInset },
                    ]}
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

            {/* Watcher-picker behind an overlap row — the same send-a-
                message flow as the title page's overlap picker, so it
                carries the same one-tap quick chips (message chips
                quick-send + land in the thread; "Write…" opens compose).
                onSelectWatcher is unused in chip mode. */}
            <WatchersSheet
                visible={!!overlapPicker}
                watchers={overlapPicker?.watchers ?? []}
                onClose={() => setOverlapPicker(null)}
                onSelectWatcher={() => {}}
                // Tappable title header → the title page. Both destinations
                // reachable from the overlap row (picker stays primary).
                titleHeader={
                    overlapPicker
                        ? {
                              title: overlapPicker.titleName ?? 'this title',
                              caption:
                                  overlapPicker.mediaType === 'movie'
                                      ? 'Movie'
                                      : 'TV',
                              posterPath: overlapPicker.posterPath,
                              onPress: () => {
                                  const target = overlapPicker;
                                  setOverlapPicker(null);
                                  router.push(
                                      `/title/${target.mediaType}/${target.tmdbId}`,
                                  );
                              },
                          }
                        : undefined
                }
                quickChips={{
                    messages: ['Worth watching?', 'What did you think?'],
                    onQuickSend: (w, message) => {
                        const target = overlapPicker;
                        setOverlapPicker(null);
                        if (target) {
                            void quickSendAboutTitle({
                                otherUserId: w.userId,
                                tmdbId: target.tmdbId,
                                mediaType: target.mediaType,
                                message,
                            });
                        }
                    },
                    onWriteYourOwn: (w) => {
                        const target = overlapPicker;
                        setOverlapPicker(null);
                        if (target) {
                            void goToChatAboutTitle({
                                otherUserId: w.userId,
                                tmdbId: target.tmdbId,
                                mediaType: target.mediaType,
                            });
                        }
                    },
                }}
            />
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
        // paddingBottom is applied inline via useBottomInset (nav-bar clearance).
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
        // Reserve a right gutter so a long title never runs under the
        // absolute "needs attention" dot (unreadDot sits at right: base,
        // 8px wide). 32 ends the text ~8px clear of the dot's left edge.
        // Applied to every row for a consistent text right-edge; the dot
        // itself is unchanged.
        paddingRight: spacing.xl,
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
