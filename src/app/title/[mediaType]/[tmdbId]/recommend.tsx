import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, Search as SearchIcon, UserPlus, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Keyboard,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import {
    KeyboardStickyView,
    useKeyboardState,
    useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
    interpolate,
    LinearTransition,
    useAnimatedStyle,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Chip } from '@/components/chip';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { promptPushAtHighIntent } from '@/lib/push';
import supabase from '@/lib/supabase';
import { createPendingRec, sharePendingRec } from '@/lib/pending-recs';
import { ensureTitle, type EnsureTitleArgs } from '@/lib/titles';
import {
    getMovie,
    getTV,
    imageUrl,
    type TMDBMovie,
    type TMDBSeason,
    type TMDBTV,
} from '@/lib/tmdb';
import {
    button,
    fontFamily,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type MediaType = 'movie' | 'tv';

interface FriendRow {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

interface TitleContext {
    title: string;
    posterPath: string | null;
}

const NOTE_MAX_LENGTH = 500;

// Selectable seasons for the rec SCOPE picker (TV only). Mirrors the episodes
// screen's derivation: seasons with real episodes, numbered ascending, with
// Specials (season 0) forced to the END; synthesize Season 1..N when TMDB
// omits the array. Unlike the episodes screen we don't need a default
// selection — the rec default is always whole-show (season null).
function deriveUsableSeasons(tv: TMDBTV): TMDBSeason[] {
    const sortKey = (n: number) => (n === 0 ? Infinity : n);
    const usable = (tv.seasons ?? [])
        .filter((s) => s.episode_count > 0)
        .sort((a, b) => sortKey(a.season_number) - sortKey(b.season_number));
    if (usable.length > 0) return usable;
    return Array.from({ length: tv.number_of_seasons || 1 }, (_, i) => ({
        season_number: i + 1,
        episode_count: 0,
        name: `Season ${i + 1}`,
    }));
}

// Same labelling the episodes screen uses: Specials for season 0.
function seasonLabel(n: number): string {
    return n === 0 ? 'Specials' : `Season ${n}`;
}

const FRIEND_AVATAR_SIZE = 44;
// Recipient chips in the note bar are deliberately smaller/quieter than the
// friend-list rows above.
const RECIPIENT_AVATAR_SIZE = 24;
// Left header thumbnail — 2:3 poster (H = W × 1.5). The title sits beside it
// via the titleContextRow flex layout, so its inset re-derives from POSTER_W
// automatically (no TITLE_INSET constant — the chips live on the 24 spine).
const POSTER_W = 60;
const POSTER_H = 90;
// Width of the right-edge fade mask over the season strip — the variable-
// width-chip equivalent of the poster strips' half-item peek: chips dissolve
// into the page instead of being hard-clipped, cueing the scroll.
const SEASON_FADE_W = 28;

export default function RecommendScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
        // Pre-selected recipient id, forwarded by /library/add when the
        // user entered the recommend flow from a friend profile.
        preselect?: string;
    }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // The pinned note bar floats above the keyboard via its own
    // KeyboardStickyView (see below); this keyboard state drives only the
    // collapsed-note search scroll inset (padding the list so friend rows
    // clear the keyboard while the note bar is collapsed).
    const keyboardState = useKeyboardState();
    // Home-indicator clearance as INTERNAL bottom padding, animated in
    // LOCKSTEP with the KeyboardStickyView lift (both read the same keyboard
    // progress, 0 closed → 1 open). The bar's tinted fill sits at the true
    // physical bottom of the screen (no upward translate), so the tint runs
    // to the edge with no gap; the padding keeps the content clear of the home
    // indicator. Closed → insets.bottom + sm (content room). Open → sm only
    // (the keyboard, not the home indicator, is below the bar). Animating
    // paddingBottom relayouts the bar per frame, but it's a handful of nodes
    // — the cost is negligible and it's what "fill to the edge" requires
    // (a transform lift would re-open the gap this fixes).
    const keyboardProgress = useReanimatedKeyboardAnimation().progress;
    const barClearanceStyle = useAnimatedStyle(() => ({
        paddingBottom: interpolate(
            keyboardProgress.value,
            [0, 1],
            [insets.bottom + spacing.sm, spacing.sm],
        ),
    }));

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);
    const preselectedFriendId =
        typeof params.preselect === 'string' && params.preselect.length > 0
            ? params.preselect
            : null;

    const [titleCtx, setTitleCtx] = useState<TitleContext | null>(null);
    // Full catalogue metadata for the title, captured at load so the send
    // can stamp public.titles via ensureTitle (send_recommendation doesn't
    // stamp it server-side). null until the TMDB detail resolves.
    const [titleStamp, setTitleStamp] = useState<EnsureTitleArgs | null>(null);
    const [friends, setFriends] = useState<FriendRow[]>([]);
    // Initial state seeds from the preselect param so the recipient is
    // pre-checked when arriving from the friend-profile recommend flow.
    // We never re-apply it after mount — once the user picks, they own
    // the selection. Set rather than scalar so the user can pick several
    // recipients and send to all of them with a single tap of Send.
    const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(
        () =>
            preselectedFriendId
                ? new Set([preselectedFriendId])
                : new Set<string>(),
    );
    const [note, setNote] = useState('');
    // In-flight guard for the "not on Seen" invite path (create pending
    // rec + share sheet) — independent of `sending` (the friend fan-out).
    const [inviteBusy, setInviteBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    // Local recipient filter — mirrors the Friends tab / library local
    // search (borderless surface pill, inline clear-X, Cancel-on-focus).
    // Filters the rendered list only; selectedFriendIds is independent, so
    // selection survives filtering and clearing.
    const [localQuery, setLocalQuery] = useState('');
    const [localFocused, setLocalFocused] = useState(false);
    const localSearchInputRef = useRef<TextInput | null>(null);
    // Optional season scope for the rec (TV only). null = whole show, the
    // default; picking a season is an additive extra step. Top-level state so
    // the choice SURVIVES the title-context collapse during friend search —
    // that collapse is a pure conditional render (titleCtx && !localFocused),
    // it never resets this. `seasons` is the selectable list derived from the
    // TV detail at load (empty for movies / single-season shows).
    const [season, setSeason] = useState<number | null>(null);
    const [seasons, setSeasons] = useState<TMDBSeason[]>([]);

    useEffect(() => {
        if (!mediaType || !Number.isFinite(tmdbId)) {
            setError('Invalid title');
            setLoading(false);
            return;
        }
        let active = true;

        // Resolve the full catalogue metadata (not just title + poster) so
        // the same fetch feeds both the header display and the send-time
        // ensureTitle stamp. Mirrors the title screen's getMovie/getTV →
        // ensureTitle mapping (empty TMDB date → null, genres → genre ids).
        // Captured from the SAME getTV response (no extra fetch) so the scope
        // picker has its season list. Stays [] for movies.
        let tvSeasons: TMDBSeason[] = [];
        const titlePromise: Promise<EnsureTitleArgs> =
            mediaType === 'movie'
                ? getMovie(tmdbId).then((m: TMDBMovie) => ({
                      tmdbId,
                      mediaType: 'movie' as const,
                      title: m.title,
                      posterPath: m.poster_path,
                      backdropPath: m.backdrop_path,
                      releaseDate:
                          m.release_date && m.release_date.length > 0
                              ? m.release_date
                              : null,
                      originalLanguage: m.original_language,
                      genreIds: m.genres.map((g) => g.id),
                  }))
                : getTV(tmdbId).then((t: TMDBTV) => {
                      tvSeasons = deriveUsableSeasons(t);
                      return {
                          tmdbId,
                          mediaType: 'tv' as const,
                          title: t.name,
                          posterPath: t.poster_path,
                          backdropPath: t.backdrop_path,
                          releaseDate:
                              t.first_air_date && t.first_air_date.length > 0
                                  ? t.first_air_date
                                  : null,
                          originalLanguage: t.original_language,
                          genreIds: t.genres.map((g) => g.id),
                      };
                  });

        (async () => {
            try {
                const [resolvedTitle, sessionResult] = await Promise.all([
                    titlePromise,
                    supabase.auth.getSession(),
                ]);
                if (!active) return;
                setTitleCtx({
                    title: resolvedTitle.title,
                    posterPath: resolvedTitle.posterPath,
                });
                setTitleStamp(resolvedTitle);
                setSeasons(tvSeasons);

                const userId = sessionResult.data.session?.user.id;
                if (!userId) throw new Error('Not authenticated');

                // Same lexicographic OR-match used by the friends tab; we
                // pick the other party per row and batch the profile
                // lookups by id.
                const { data: friendships, error: friendshipsError } = await supabase
                    .from('friendships')
                    .select('user_a_id, user_b_id')
                    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`);
                if (friendshipsError) throw friendshipsError;
                if (!active) return;

                const otherIds = (friendships ?? []).map((f) =>
                    f.user_a_id === userId ? f.user_b_id : f.user_a_id,
                );

                if (otherIds.length === 0) {
                    setFriends([]);
                    return;
                }

                const [
                    { data: profiles, error: profilesError },
                    { data: sentRecs, error: sentRecsError },
                ] = await Promise.all([
                    supabase
                        .from('profiles')
                        .select('id, handle, display_name, avatar_url')
                        .in('id', otherIds),
                    // Recency ranking input: every rec the current user has
                    // SENT, newest first. We only need (recipient, sent_at);
                    // the first row seen per recipient is their most recent.
                    supabase
                        .from('recommendations')
                        .select('to_user_id, sent_at')
                        .eq('from_user_id', userId)
                        .order('sent_at', { ascending: false }),
                ]);
                if (profilesError) throw profilesError;
                if (sentRecsError) throw sentRecsError;
                if (!active) return;

                // Friend id -> most-recent sent_at. Query is already sorted
                // newest-first, so the first hit per recipient wins.
                const lastSentTo = new Map<string, string>();
                for (const r of sentRecs ?? []) {
                    if (r.to_user_id && r.sent_at && !lastSentTo.has(r.to_user_id)) {
                        lastSentTo.set(r.to_user_id, r.sent_at);
                    }
                }

                const rows: FriendRow[] = (profiles ?? []).map((p) => ({
                    userId: p.id,
                    handle: p.handle,
                    displayName: p.display_name,
                    avatarUrl: p.avatar_url,
                }));

                // Reorder (never filter): friends you've sent to most recently
                // rise to the top by sent_at desc; everyone you've never sent
                // to falls below, alphabetical by name for a stable order. ISO
                // timestamps compare correctly as strings.
                rows.sort((a, b) => {
                    const aSent = lastSentTo.get(a.userId);
                    const bSent = lastSentTo.get(b.userId);
                    if (aSent && bSent) {
                        return aSent < bSent ? 1 : aSent > bSent ? -1 : 0;
                    }
                    if (aSent) return -1;
                    if (bSent) return 1;
                    return a.displayName.localeCompare(b.displayName);
                });

                setFriends(rows);
            } catch (err) {
                if (!active) return;
                console.error('recommend init failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId]);

    const trimmedNote = note.trim();
    const selectedCount = selectedFriendIds.size;
    const canSend =
        !sending && selectedCount > 0 && mediaType !== null && !loading;

    // Recipients shown in the note bar (avatar + name, one row each) so the
    // user sees exactly who they're sending to while the note field is focused
    // and the friend list is hidden behind the keyboard. Order + data come from
    // the loaded friends list; selection is independent of the search filter, so
    // a filtered-out pick still appears here.
    const selectedRecipients = friends.filter((f) =>
        selectedFriendIds.has(f.userId),
    );

    // Case-insensitive match against display name AND @handle (haystack
    // includes "@" so typing it or omitting it both work). Filtering
    // preserves the recency order already baked into `friends`.
    const normalizedQuery = localQuery.trim().toLowerCase();
    const filteredFriends =
        normalizedQuery.length === 0
            ? friends
            : friends.filter((f) =>
                  `${f.displayName} @${f.handle}`
                      .toLowerCase()
                      .includes(normalizedQuery),
              );

    function toggleFriend(userId: string) {
        const isAdding = !selectedFriendIds.has(userId);
        setSelectedFriendIds((prev) => {
            const next = new Set(prev);
            if (next.has(userId)) {
                next.delete(userId);
            } else {
                next.add(userId);
            }
            return next;
        });
        // On ADD only: dismiss the keyboard so the search field blurs
        // (localFocused → false), which via the existing collapse logic expands
        // the note bar (recipient chips + ADD A NOTE + input) into view — so a
        // user who searched-and-selected can't miss the note field. Removing a
        // recipient must NOT yank the keyboard. No-op when no keyboard is up
        // (unfiltered selection); does not clear the search text or focus the
        // note input.
        if (isAdding) Keyboard.dismiss();
    }

    // Recipient id -> display name for user-facing copy.
    function displayNameFor(id: string) {
        return friends.find((f) => f.userId === id)?.displayName ?? 'a friend';
    }

    // Gentle, sentence-case heads-up line for a recipient who already has
    // this title in their (friends-visible) library.
    function alreadyHasLine(name: string, status: string): string {
        switch (status) {
            case 'watched':
                return `${name} has already watched this.`;
            case 'watching':
                return `${name} is already watching this.`;
            case 'watchlist':
                return `It's already on ${name}'s watchlist.`;
            default:
                return `${name} already has this in their library.`;
        }
    }

    // Promise-wrapped Alert so handleSend can await the sender's choice.
    // Non-blocking by design: "Send anyway" is always offered — this is
    // information, not a restriction.
    function confirmSendAnyway(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            Alert.alert('Heads up', message, [
                { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
                { text: 'Send anyway', onPress: () => resolve(true) },
            ]);
        });
    }

    // Recommend to someone NOT on Seen: create a pending_recommendations
    // row (the note applies exactly as a normal rec's would), then open
    // the share sheet with the seenrecs.com/r/ landing link. Order
    // matters: ensureTitle is AWAITED here (not fire-and-forget like the
    // normal send) because the landing page renders from the titles row —
    // sharing a link before the stamp lands would 404 its poster/title.
    // A dismissed share sheet deliberately KEEPS the row: the link may
    // already be in flight, and the sender can reshare it later.
    async function handleInviteSend() {
        if (inviteBusy || sending || !mediaType) return;
        setInviteBusy(true);
        try {
            if (titleStamp) await ensureTitle(titleStamp);
            const token = await createPendingRec({
                tmdbId,
                mediaType,
                note: trimmedNote.length > 0 ? trimmedNote : null,
                // Season scope survives the invite-then-join (server column +
                // claim RPC are live). TV only, null (whole show) otherwise.
                season: mediaType === 'tv' ? season : null,
            });
            const shared = await sharePendingRec(
                token,
                titleCtx?.title ?? 'this',
            );
            // Same semantics as the onboarding invite: only an explicit
            // share closes the flow; a cancel stays here for a retry.
            if (shared) router.back();
        } catch (err) {
            console.error('invite rec failed:', err);
            Alert.alert(
                "Couldn't create the invite",
                'Check your connection and try again.',
            );
        } finally {
            setInviteBusy(false);
        }
    }

    async function handleSend() {
        if (!canSend || !mediaType) return;
        setSending(true);
        const recipientIds = Array.from(selectedFriendIds);
        try {
            // Privacy-safe heads-up. RLS on items (is_item_visible_to_auth)
            // returns a row ONLY when it's friends-visible — visibility =
            // 'friends' AND we're a confirmed friend. A PRIVATE item returns
            // nothing here, indistinguishable from "no item", so the sender
            // can never infer a hidden library entry. The privacy gate is
            // enforced by the database, not by this query.
            const { data: visibleItems, error: itemsError } = await supabase
                .from('items')
                .select('user_id, status')
                .in('user_id', recipientIds)
                .eq('tmdb_id', tmdbId)
                .eq('media_type', mediaType);
            if (itemsError) throw itemsError;

            if (visibleItems && visibleItems.length > 0) {
                // One line per already-has recipient, ordered by the picker
                // for stable copy. Recipients with no (visible) item are
                // silently absent — no "they haven't seen it" signal.
                const message = recipientIds
                    .map((id) => {
                        const hit = visibleItems.find((it) => it.user_id === id);
                        return hit
                            ? alreadyHasLine(displayNameFor(id), hit.status)
                            : null;
                    })
                    .filter((line): line is string => line !== null)
                    .join('\n');
                const proceed = await confirmSendAnyway(message);
                if (!proceed) {
                    setSending(false);
                    return;
                }
            }

            await performSend(recipientIds, mediaType);
        } catch (err) {
            console.error('send recommendation failed:', err);
            surfaceError(err, "Couldn't send");
            setSending(false);
        }
    }

    async function performSend(recipientIds: string[], mt: MediaType) {
        try {
            // Stamp the title into public.titles so it's catalogued for the
            // recipient's home/inbox render (send_recommendation doesn't do
            // this server-side). Fire-and-forget — ensureTitle swallows its
            // own failures (titles.ts), and the home screen has its own
            // TMDB fallback, so a missed stamp never blocks the send.
            if (titleStamp) void ensureTitle(titleStamp);

            // Fan out to all recipients in parallel via the existing
            // single-recipient RPC. allSettled (not Promise.all) so one
            // bad recipient doesn't abort the rest — each rec is its own
            // row and its own rec_received notification through the
            // existing trigger path, so partial success is meaningful.
            const results = await Promise.allSettled(
                recipientIds.map((toId) =>
                    supabase.rpc('send_recommendation', {
                        to_user_id: toId,
                        tmdb_id: tmdbId,
                        media_type: mt,
                        note: trimmedNote.length > 0 ? trimmedNote : undefined,
                        // Season scope — TV + a picked season only; omitted
                        // (→ the RPC's null default = whole show) otherwise.
                        // The picker never sets a season for a movie, but gate
                        // on mt defensively.
                        season:
                            mt === 'tv' && season !== null ? season : undefined,
                    }),
                ),
            );

            const nameFor = displayNameFor;
            const sent: string[] = [];
            const alreadySent: string[] = [];
            const failed: { name: string; message: string }[] = [];

            results.forEach((result, i) => {
                const toId = recipientIds[i];
                const name = nameFor(toId);
                if (result.status === 'rejected') {
                    // Network-level rejection (the supabase-js call never
                    // resolved). Rare but possible on offline.
                    failed.push({
                        name,
                        message:
                            result.reason instanceof Error
                                ? result.reason.message
                                : String(result.reason),
                    });
                    return;
                }
                // Fulfilled: supabase.rpc resolves with { data, error }
                // — the RPC error lives in result.value.error, not a
                // rejected promise.
                const rpcError = result.value.error;
                if (!rpcError) {
                    sent.push(name);
                    return;
                }
                // 23505 = unique_violation on recommendations_pair_unique
                // (from_user_id, to_user_id, tmdb_id, media_type). Means
                // the user already recommended this exact title to this
                // exact friend at some point — and recs are immutable on
                // the sender side, so we leave the existing one alone
                // and report it as a benign no-op rather than a failure.
                if (rpcError.code === '23505') {
                    alreadySent.push(name);
                    return;
                }
                failed.push({ name, message: rpcError.message });
            });

            // Build one summary message that names which recipients
            // landed in which bucket. Title flips to "Partially sent" /
            // "Couldn't send" if anything actually failed.
            const lines: string[] = [];
            if (sent.length > 0) {
                lines.push(
                    sent.length === 1
                        ? `Sent to ${sent[0]}.`
                        : `Sent to ${sent.length} friends: ${sent.join(', ')}.`,
                );
            }
            if (alreadySent.length > 0) {
                lines.push(
                    alreadySent.length === 1
                        ? `${alreadySent[0]} already had this rec — left as-is.`
                        : `Already recommended to ${alreadySent.join(', ')} — left as-is.`,
                );
            }
            if (failed.length > 0) {
                lines.push(
                    `Couldn't send to ${failed.map((f) => f.name).join(', ')}.`,
                );
            }

            const anySuccess = sent.length > 0 || alreadySent.length > 0;
            const alertTitle =
                failed.length === 0
                    ? 'Sent'
                    : anySuccess
                      ? 'Partially sent'
                      : "Couldn't send";

            Alert.alert(alertTitle, lines.join('\n\n'), [
                {
                    text: 'OK',
                    onPress: async () => {
                        // Only pop back if at least one rec actually
                        // landed; if every recipient failed, leave the
                        // modal up so the user can retry.
                        if (anySuccess) router.back();

                        // Sending a genuinely NEW rec is a high-intent
                        // moment to ask for push — gate strictly on the
                        // `sent` branch, never alreadySent no-ops or
                        // failures. Fire only after this "Sent" alert is
                        // dismissed so the permission explainer doesn't
                        // stack on top of it. Matches the friend-accept
                        // sites: inline session lookup, and
                        // promptPushAtHighIntent swallows its own errors.
                        if (sent.length > 0) {
                            const {
                                data: { session },
                            } = await supabase.auth.getSession();
                            if (session?.user.id) {
                                await promptPushAtHighIntent(session.user.id);
                            }
                        }
                    },
                },
            ]);
        } catch (err) {
            console.error('send recommendation failed:', err);
            surfaceError(err, "Couldn't send");
        } finally {
            setSending(false);
        }
    }

    function renderAvatar(row: FriendRow) {
        if (row.avatarUrl) {
            return (
                <Image
                    source={{ uri: row.avatarUrl }}
                    style={[styles.avatar, { backgroundColor: palette.accent }]}
                    contentFit="cover"
                    transition={150}
                />
            );
        }
        const letter = row.displayName[0]?.toUpperCase() ?? '?';
        return (
            <View
                style={[
                    styles.avatar,
                    styles.avatarFallback,
                    { backgroundColor: palette.accent },
                ]}
            >
                <Text
                    style={[typography.bodyEmphasis, { color: palette.textInverse }]}
                >
                    {letter}
                </Text>
            </View>
        );
    }

    function renderFriendRow(row: FriendRow) {
        const isSelected = selectedFriendIds.has(row.userId);
        return (
            <Pressable
                key={row.userId}
                onPress={() => toggleFriend(row.userId)}
                style={({ pressed }) => [
                    styles.friendRow,
                    isSelected && { backgroundColor: palette.accentSubtle },
                    pressed && { opacity: 0.6 },
                ]}
            >
                {renderAvatar(row)}
                <View style={styles.friendText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {row.displayName}
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        @{row.handle}
                    </Text>
                </View>
                <View
                    style={[
                        styles.checkCircle,
                        {
                            borderColor: isSelected ? palette.accent : palette.border,
                            backgroundColor: isSelected
                                ? palette.accent
                                : 'transparent',
                        },
                    ]}
                >
                    {isSelected && (
                        <Check
                            color={palette.textInverse}
                            size={16}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    )}
                </View>
            </Pressable>
        );
    }

    // Title + poster + the "what to recommend" scope strip. Collapses while
    // the friend search is focused so the list owns the space above the
    // keyboard. Shared by the FlatList header and the zero-friends branch.
    const titleContextNode =
        titleCtx && !localFocused ? (
            <View style={styles.titleContextBlock}>
                <View style={styles.titleContextRow}>
                    {titleCtx.posterPath ? (
                        <Image
                            source={{ uri: imageUrl(titleCtx.posterPath, 'w185') }}
                            style={styles.contextPoster}
                            contentFit="cover"
                            transition={150}
                        />
                    ) : (
                        <View
                            style={[
                                styles.contextPoster,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                        />
                    )}
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            styles.contextTitle,
                            { color: palette.text },
                        ]}
                        numberOfLines={2}
                    >
                        {titleCtx.title}
                    </Text>
                </View>

                {/* Scope picker — TV only, ≥2 selectable seasons. Re-placed
                    onto the 24 spine (scopeBlock no longer indents under the
                    title); behaviour, chips, fade, and wiring are unchanged. */}
                {mediaType === 'tv' && seasons.length >= 2 && (
                    <View style={styles.scopeBlock}>
                        <Text
                            style={[
                                typography.overline,
                                { color: palette.textMuted },
                            ]}
                        >
                            What to recommend
                        </Text>
                        <View style={styles.seasonStripWrap}>
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                style={styles.seasonScroll}
                                contentContainerStyle={styles.seasonStrip}
                            >
                                <Chip
                                    label="Whole show"
                                    active={season === null}
                                    onPress={() => setSeason(null)}
                                    accessibilityLabel="Recommend the whole show"
                                />
                                {seasons.map((s) => (
                                    <Chip
                                        key={s.season_number}
                                        label={seasonLabel(s.season_number)}
                                        active={season === s.season_number}
                                        onPress={() =>
                                            setSeason(s.season_number)
                                        }
                                        accessibilityLabel={`Recommend ${seasonLabel(
                                            s.season_number,
                                        )}`}
                                    />
                                ))}
                            </ScrollView>
                            <LinearGradient
                                colors={[palette.bgTransparent, palette.bg]}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.seasonFade}
                                pointerEvents="none"
                            />
                        </View>
                    </View>
                )}
            </View>
        ) : null;

    // Local recipient filter — borderless surface pill, inline clear-X,
    // Cancel/Done sibling on focus. Selection lives in selectedFriendIds, so
    // filtering never drops a pick.
    const searchNode = (
        <View style={styles.searchRow}>
            <View
                style={[styles.searchBar, { backgroundColor: palette.surface }]}
            >
                <SearchIcon
                    color={palette.textMuted}
                    size={20}
                    strokeWidth={ICON_STROKE_WIDTH}
                />
                <TextInput
                    ref={localSearchInputRef}
                    value={localQuery}
                    onChangeText={setLocalQuery}
                    placeholder="Search friends"
                    placeholderTextColor={palette.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    onFocus={() => setLocalFocused(true)}
                    onBlur={() => setLocalFocused(false)}
                    style={[
                        styles.searchInput,
                        typography.body,
                        { color: palette.text },
                    ]}
                />
                {localQuery.length > 0 ? (
                    <Pressable
                        onPress={() => setLocalQuery('')}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <X
                            color={palette.textMuted}
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                ) : null}
            </View>
            {localFocused ? (
                <Pressable
                    onPress={() => {
                        setLocalQuery('');
                        localSearchInputRef.current?.blur();
                    }}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Done searching"
                    style={({ pressed }) => [
                        styles.cancelButton,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Done
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );

    // "Not on Seen" path — a single left-aligned link on the 24 spine (was a
    // centred two-part sentence). The note applies to this send exactly as a
    // friend send.
    const inviteLinkNode = (
        <Pressable
            onPress={() => void handleInviteSend()}
            disabled={inviteBusy}
            accessibilityRole="button"
            accessibilityLabel="Recommend to someone not on Seen"
            style={({ pressed }) => [
                styles.inviteRow,
                { opacity: pressed || inviteBusy ? 0.6 : 1 },
            ]}
        >
            {inviteBusy ? (
                <ActivityIndicator size="small" color={palette.accent} />
            ) : (
                <>
                    {/* Leading person-plus anchors it as an action (inviting a
                        NEW person, not just text). Accent, sized to the text. */}
                    <UserPlus
                        color={palette.accent}
                        size={16}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        // body (16) not caption (14) + medium 500 — a little
                        // more present so it doesn't read as weak. Still
                        // left-aligned on the spine, not a heading.
                        style={[
                            typography.body,
                            styles.inviteRowAction,
                            { color: palette.accent },
                        ]}
                    >
                        Send to someone not on Seen
                    </Text>
                </>
            )}
        </Pressable>
    );

    // FlatList header — everything above the recipient list scrolls away with
    // it; the list is the screen (the recipients are the job). All on the 24
    // spine. "Send to" uses the SAME overline token as "What to recommend" so
    // the two section labels are peers.
    const listHeaderNode = (
        <>
            {titleContextNode}
            {searchNode}
            {inviteLinkNode}
            <Text
                style={[
                    typography.overline,
                    styles.sectionLabel,
                    { color: palette.textMuted },
                ]}
            >
                Send to
            </Text>
        </>
    );

    return (
        // Plain View, NOT SafeAreaView: under fullScreenModal the SafeAreaView
        // component's edge padding comes back ~0 (it doesn't apply inside the
        // native modal's view hierarchy). The useSafeAreaInsets() HOOK does
        // report the real inset here (same as the title page's close button),
        // so the header pads from insets.top directly.
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <View
                style={[
                    styles.header,
                    { paddingTop: insets.top + spacing.sm },
                ]}
            >
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Cancel
                    </Text>
                </Pressable>
                {/* No centred page title — the poster + show name below are the
                    header now. Standard modal header: Cancel · empty · Send. */}
                {/* Send lives in the header (top-right, opposite Cancel)
                    rather than the pinned bottom bar — the header never
                    moves with the keyboard, so Send is always reachable
                    while typing the note. It hugs its content at rest
                    ("Send") and the LinearTransition wrapper animates its
                    width as the label grows to "Send to N" (replaces the old
                    minWidth:104 that killed the pop by padding "Send" out). */}
                <Animated.View layout={LinearTransition.duration(180)}>
                <Pressable
                    onPress={handleSend}
                    disabled={!canSend}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel={
                        selectedCount === 0
                            ? 'Send'
                            : `Send to ${selectedCount}`
                    }
                    style={({ pressed }) => [
                        styles.sendButton,
                        {
                            backgroundColor:
                                canSend || sending
                                    ? palette.accent
                                    : palette.surfaceAlt,
                            opacity: pressed && canSend ? 0.8 : 1,
                        },
                    ]}
                >
                    {sending ? (
                        <ActivityIndicator color={palette.textInverse} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                {
                                    color: canSend
                                        ? palette.textInverse
                                        : palette.textMuted,
                                },
                            ]}
                        >
                            {selectedCount === 0
                                ? 'Send'
                                : `Send to ${selectedCount}`}
                        </Text>
                    )}
                </Pressable>
                </Animated.View>
            </View>

            {/* No KeyboardAvoidingView on this column — Send is in the
                header (reachable while typing) and the note bar is lifted by
                its own KeyboardStickyView below. The recipient list is a
                FlatList and the title/scope/search/invite are its header, so
                the header scrolls away and the list is the screen. */}
            <View style={styles.flex}>
                {showLoader ? (
                    <FullScreenLoader />
                ) : error ? (
                    <View style={styles.statusBlock}>
                        <Text style={[typography.body, { color: palette.error }]}>
                            {error}
                        </Text>
                    </View>
                ) : friends.length === 0 ? (
                    // Zero friends — the invite IS the primary path, so it
                    // keeps its full-size treatment. Scrolls (no list to back).
                    <ScrollView
                        style={styles.flex}
                        contentContainerStyle={styles.scrollContent}
                        keyboardShouldPersistTaps="handled"
                    >
                        {titleContextNode}
                        <View style={styles.statusBlock}>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.textMuted },
                                ]}
                                numberOfLines={3}
                            >
                                You don&apos;t have any friends yet — but you
                                can still send this to someone.
                            </Text>
                        </View>
                        <View style={styles.inviteGroup}>
                            <Text
                                style={[
                                    typography.caption,
                                    styles.inviteCaption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Know someone who&apos;s not on Seen yet?
                            </Text>
                            <Pressable
                                onPress={() => void handleInviteSend()}
                                disabled={inviteBusy}
                                accessibilityRole="button"
                                accessibilityLabel="Recommend to someone not on Seen"
                                style={({ pressed }) => [
                                    styles.inviteButton,
                                    {
                                        borderColor: palette.accent,
                                        opacity: pressed || inviteBusy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                {inviteBusy ? (
                                    <ActivityIndicator color={palette.accent} />
                                ) : (
                                    <Text
                                        style={[
                                            typography.bodyEmphasis,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        Send them this rec
                                    </Text>
                                )}
                            </Pressable>
                        </View>
                    </ScrollView>
                ) : (
                    <FlatList
                        style={styles.flex}
                        data={filteredFriends}
                        keyExtractor={(f) => f.userId}
                        renderItem={({ item }) => renderFriendRow(item)}
                        ListHeaderComponent={listHeaderNode}
                        ListEmptyComponent={
                            <Text
                                style={[
                                    typography.body,
                                    styles.noMatch,
                                    { color: palette.textMuted },
                                ]}
                            >
                                No friends match “{localQuery.trim()}”.
                            </Text>
                        }
                        contentContainerStyle={[
                            styles.scrollContent,
                            keyboardState.height > 0
                                ? {
                                      paddingBottom:
                                          keyboardState.height + spacing.sm,
                                  }
                                : null,
                        ]}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="on-drag"
                    />
                )}

                {/* Pinned bottom bar: note input + char count. Send moved to
                    the header so it stays reachable above the keyboard. The
                    bar pins to the bottom (visible regardless of friend-list
                    scroll position so the note is never below the fold).
                    KeyboardStickyView lifts it onto the keyboard's top edge
                    when open; barClearanceStyle animates the closed-state
                    home-indicator lift on the SAME keyboard progress, so the
                    two move together (no overshoot). paddingBottom is the
                    constant internal content room. */}
                {!loading && !error && friends.length > 0 && !localFocused ? (
                    <KeyboardStickyView>
                    <Animated.View
                        style={[
                            styles.bottomBar,
                            // paddingBottom comes from barClearanceStyle
                            // (animated: insets.bottom + sm when closed → sm
                            // when open), so the tint reaches the screen edge.
                            barClearanceStyle,
                            {
                                // Slight tint (surfaceAlt) lifts the bar off
                                // the page; the top stroke is gone (see
                                // styles.bottomBar) — the tone is the
                                // separation now.
                                backgroundColor: palette.surfaceAlt,
                            },
                        ]}
                    >
                        {/* Who this rec is going to — one quiet avatar + name
                            row per recipient, so they stay visible while the
                            note field is focused and the friend list is hidden
                            behind the keyboard. One fixed-height row; past what
                            fits it scrolls horizontally, so it never crowds out
                            the note input. */}
                        {selectedRecipients.length > 0 ? (
                            <ScrollView
                                horizontal
                                style={styles.recipientScroll}
                                contentContainerStyle={
                                    styles.recipientScrollContent
                                }
                                showsHorizontalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                            >
                                {selectedRecipients.map((r) => (
                                    <View
                                        key={r.userId}
                                        style={styles.recipientChip}
                                    >
                                        <Avatar
                                            avatarUrl={r.avatarUrl}
                                            displayName={r.displayName}
                                            seedId={r.userId}
                                            size={RECIPIENT_AVATAR_SIZE}
                                        />
                                        <Text
                                            style={[
                                                typography.caption,
                                                styles.recipientName,
                                                { color: palette.textMuted },
                                            ]}
                                            numberOfLines={1}
                                        >
                                            {r.displayName}
                                        </Text>
                                    </View>
                                ))}
                            </ScrollView>
                        ) : null}
                        <Text
                            style={[
                                typography.micro,
                                styles.bottomBarLabel,
                                { color: palette.textMuted },
                            ]}
                        >
                            ADD A NOTE (OPTIONAL)
                        </Text>
                        <View
                            style={[
                                styles.noteBox,
                                { backgroundColor: palette.surface },
                            ]}
                        >
                            <TextInput
                                value={note}
                                onChangeText={(v) =>
                                    setNote(v.slice(0, NOTE_MAX_LENGTH))
                                }
                                placeholder="Why are you recommending this?"
                                placeholderTextColor={palette.textMuted}
                                multiline
                                maxLength={NOTE_MAX_LENGTH}
                                editable={!sending}
                                style={[
                                    styles.noteInput,
                                    typography.body,
                                    { color: palette.text },
                                ]}
                            />
                        </View>
                        <Text
                            style={[
                                typography.caption,
                                styles.charCount,
                                { color: palette.textMuted },
                            ]}
                        >
                            {note.length}/{NOTE_MAX_LENGTH}
                        </Text>
                    </Animated.View>
                    </KeyboardStickyView>
                ) : null}
            </View>
        </View>
    );
}

function surfaceError(err: unknown, title: string) {
    if (err && typeof err === 'object' && 'message' in err) {
        const supaErr = err as {
            message: string;
            details?: string;
            hint?: string;
            code?: string;
        };
        Alert.alert(
            title,
            `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
        );
    } else {
        Alert.alert(title, String(err));
    }
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        // Horizontal inset matches every body element in the modal so
        // the Cancel / Send row edge-aligns with the title context,
        // section labels, friend list, and note box below.
        paddingHorizontal: spacing.lg,
        // paddingTop is applied inline as insets.top + sm (see the header in
        // the render): under fullScreenModal the top inset must come from the
        // useSafeAreaInsets() hook, not the SafeAreaView component (which
        // reported ~0 here). sm is just the gap below the measured inset.
        paddingBottom: spacing.sm,
    },
    sendButton: {
        // Compact filled header button — the app's button radius (the
        // shared geometry token) at header scale. Fill/label colors resolve
        // per state inline (plum/white actionable, surfaceAlt/muted disabled).
        // It HUGS its content ("Send" at rest); the LinearTransition wrapper
        // in the header animates the width up to "Send to N" (replaces the
        // old minWidth:104, which killed the pop by padding "Send" out wide).
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scrollContent: {
        paddingBottom: spacing.xl,
    },
    titleContextBlock: {
        // Owns the vertical rhythm for the title row + the scope strip below
        // it. gap xl (32): a real SECTION break between the poster + show name
        // (the screen's header now) and "What to recommend" — clearly larger
        // than the 8 section-header-to-content gap AND than the header→poster
        // gap, so the title reads as its own zone. paddingBottom sm keeps
        // chips → search at a normal section gap (sm + searchRow.marginTop sm).
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.xl,
    },
    titleContextRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
    },
    scopeBlock: {
        // On the 24 spine like every other element. No right padding — the
        // strip bleeds to the screen edge for the fade. gap sm (8) is the ONE
        // section-header-to-content gap used everywhere (label → chips ===
        // "Send to" → avatar === note label → box), so the rhythm is uniform.
        paddingLeft: spacing.lg,
        gap: spacing.sm,
    },
    seasonStripWrap: {
        // Relative host for the strip + its right-edge fade overlay.
        position: 'relative',
    },
    seasonScroll: {
        // flexGrow 0 so the horizontal strip takes only its content height in
        // the surrounding column (matches the episodes screen).
        flexGrow: 0,
    },
    seasonStrip: {
        flexDirection: 'row',
        gap: spacing.xs,
        // No left inset — scopeBlock provides it. Right inset ≥ the fade width
        // so the last chip can scroll fully clear of the fade at the end.
        paddingRight: spacing.xl,
    },
    seasonFade: {
        // Right-edge mask: chips dissolve into the page bg instead of a hard
        // clip, cueing the horizontal scroll (the variable-chip equivalent of
        // the poster strips' half-item peek).
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        width: SEASON_FADE_W,
    },
    contextPoster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    contextTitle: {
        flex: 1,
    },
    statusBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xxl,
        paddingHorizontal: spacing.xl,
    },
    // "Not on Seen" link — a single left-aligned accent link on the 24 spine
    // (was a centred two-part sentence), between the search field and the
    // "Send to" label. No fill or border; the accent text is the affordance.
    inviteRow: {
        // Left-aligned row on the spine: leading person-plus glyph + text.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        marginTop: spacing.xs,
    },
    inviteRowAction: {
        fontFamily: fontFamily.medium,
        fontWeight: '500',
    },
    // Zero-friends empty-state variant — caption + outlined secondary
    // (mirrors friends/add.tsx's inviteGroup, on the shared button
    // geometry). With no list to lead, the invite IS the primary path
    // here, so it keeps the full-size treatment.
    inviteGroup: {
        gap: spacing.sm,
        marginTop: spacing.xl,
        // On the 24 spine — the button is no longer full-bleed.
        paddingHorizontal: spacing.lg,
    },
    inviteCaption: {
        textAlign: 'center',
    },
    inviteButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sectionLabel: {
        // Positioning only — the typography (overline) is shared with the
        // "What to recommend" label so the two section headers are peers. No
        // letterSpacing override here; the overline token owns it.
        paddingHorizontal: spacing.lg,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
    },
    searchRow: {
        // Hosts the search pill + conditional Cancel sibling. Horizontal
        // inset matches the other elements on the 24 spine. marginTop sm (was
        // md) — with titleContextBlock.paddingBottom sm, the chips → search
        // gap is 16, a normal section gap.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        marginTop: spacing.sm,
        marginBottom: spacing.sm,
    },
    searchBar: {
        // Borderless surface pill (surface-vs-bg is the separation), flex
        // so it shrinks when Cancel appears. Mirrors Friends/library search.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    cancelButton: {
        paddingHorizontal: spacing.xs,
    },
    searchInput: {
        flex: 1,
        // Parent's fixed height owns vertical sizing.
        paddingVertical: 0,
    },
    noMatch: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
    },
    friendRow: {
        // Row content sits on the 24 spine (avatar/name at lg), while the
        // selection highlight (the row background) spans FULL width — the
        // FlatList gives the rows no horizontal inset, so the row owns the lg
        // padding and the highlight bleeds edge to edge (no borderRadius, so
        // it reads as a full-width band, not an inset pill).
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    avatar: {
        width: FRIEND_AVATAR_SIZE,
        height: FRIEND_AVATAR_SIZE,
        borderRadius: FRIEND_AVATAR_SIZE / 2,
    },
    avatarFallback: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    friendText: {
        flex: 1,
        gap: spacing.xs,
    },
    checkCircle: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    noteBox: {
        // Borderless — sits flat on the tinted bar. The surface fill (white)
        // against the surfaceAlt bar is the field's edge; a border here would
        // reintroduce the stroke removed from the bar. No strokes anywhere.
        borderRadius: radius.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        minHeight: 80,
    },
    noteInput: {
        minHeight: 60,
        // Cap so the bar's height is bounded as the user types — the
        // multiline TextInput scrolls internally for content beyond
        // this height. Without a cap, the bar could grow tall enough
        // to push its bottom edge below the keyboard top.
        maxHeight: 120,
        textAlignVertical: 'top',
    },
    charCount: {
        textAlign: 'right',
        marginTop: spacing.xs,
    },
    // Pinned-bottom container. Slight surfaceAlt tint (applied inline) lifts
    // it off the page — no top stroke (removed); the tone is the separation.
    // lg horizontal inset keeps the note box on the 24 spine.
    bottomBar: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
    },
    bottomBarLabel: {
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    recipientScroll: {
        // A single fixed-height row of recipient chips. Flow horizontally;
        // past what fits, it scrolls sideways so many recipients never push the
        // note input off-screen. flexGrow:0 keeps it from stretching tall.
        flexGrow: 0,
        marginBottom: spacing.sm,
        // Bleed to the bar's edges (cancel its paddingHorizontal) so an
        // overflowing row is clipped right at the visual edge — the last chip
        // straddles it (peek affordance) instead of ending flush inside the
        // inset. The content padding below restores the first chip's alignment
        // and adds trailing room. When everything fits there's no overflow, so
        // no clip and no visible change.
        marginHorizontal: -spacing.lg,
    },
    recipientScrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.lg,
    },
    recipientChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    recipientName: {
        // Truncate long names (numberOfLines={1}) so several chips fit across.
        maxWidth: 120,
    },
});
