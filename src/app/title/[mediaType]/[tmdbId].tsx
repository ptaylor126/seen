import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ExternalLink, Send, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { AvatarStack, type AvatarStackItem } from '@/components/avatar-stack';
import { RatingSheet } from '@/components/rating-sheet';
import { getRegion } from '@/lib/locale';
import { applyWatchedRating, formatRatingStars, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { ensureTitle } from '@/lib/titles';
import {
    getMovie,
    getMovieWatchProviders,
    getTV,
    getTVWatchProviders,
    imageUrl,
    type TMDBMovie,
    type TMDBTV,
    type TMDBWatchProvidersRegion,
} from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type ItemStatus = 'watchlist' | 'watching' | 'watched';

// Discriminated union so render code can narrow on `type` and access the
// right shape (TMDBMovie.title vs TMDBTV.name etc.).
type Detail =
    | { type: 'movie'; data: TMDBMovie }
    | { type: 'tv'; data: TMDBTV };

const STATUSES: ItemStatus[] = ['watchlist', 'watching', 'watched'];
const STATUS_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};

const BACKDROP_HEIGHT = 240;
const POSTER_WIDTH = 100;
const POSTER_HEIGHT = 150;

interface Sender {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

// Rec attribution shown above the backdrop whenever this title has been
// recommended to the current user. `senders` is the deduped list of
// recommenders (ordered by most recent rec first); `totalCount` matches
// senders.length but is kept distinct in case we later cap the displayed
// list. `note` is set only when arrived via ?fromRec=<id> — that param
// pins which rec's note to surface; without it the senders are shown
// without a quoted note.
interface RecContext {
    senders: Sender[];
    totalCount: number;
    note: string | null;
}

// One review row + its author profile, rendered in the Reviews
// section. `author` can be null in the defensive case where the
// author's profile row wasn't returned by the batch lookup — RLS on
// profiles is permissive, but the column is null-typed to keep the
// renderer robust.
interface ReviewItem {
    id: string;
    userId: string;
    body: string;
    containsSpoilers: boolean;
    updatedAt: string;
    author: {
        displayName: string;
        avatarUrl: string | null;
    } | null;
}

// Relative timestamp matching the style used in inbox.tsx /
// rec/[recId].tsx. Kept local rather than extracted to a shared
// helper since the three callers all want slightly different
// behaviour at their boundaries (this one falls back to a date string
// after a week; review timestamps that are years old still want to
// read as dates, not "104w").
function reviewTimestamp(iso: string): string {
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

// Compact social signal for this title across the user's friends.
// Watchers = friends with status='watching'; ratings summary aggregates
// across friends with a non-null rating. Watchlist entries are
// intentionally excluded — the section is about engagement, not intent,
// and including watchlist would make it noisy without adding signal.
// Privacy is enforced by RLS (`visibility = 'friends'` for non-self
// rows), AND we filter visibility explicitly client-side as defence
// in depth.
interface FriendActivity {
    watchers: AvatarStackItem[];
    // Mean of stored 1-10 values across rating-bearing friends. Convert
    // to stars at render time via formatRatingStars-style division.
    ratingsAverage: number | null;
    ratingsCount: number;
}

// Map an items row to a one-line marker for the current user's
// relationship to this title — used in the YOUR row above the
// status pills.
function formatYourMarker(
    status: ItemStatus | null,
    rating: number | null,
): string | null {
    if (!status) return null;
    if (status === 'watchlist') return 'On your watchlist';
    if (status === 'watching') return "You're watching this";
    // status === 'watched'
    if (rating !== null) return `You rated this ${formatRatingStars(rating)}`;
    return "You've watched this";
}

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
}

function formatSenderLine(senders: Sender[]): string {
    if (senders.length === 0) return '';
    const names = senders.map((s) => firstName(s.displayName));
    if (names.length === 1) {
        return `${names[0]} recommended this to you`;
    }
    if (names.length === 2) {
        return `${names[0]} & ${names[1]} recommended this to you`;
    }
    const others = names.length - 2;
    return `${names[0]}, ${names[1]} & ${others} other${
        others === 1 ? '' : 's'
    } recommended this to you`;
}

export default function TitleDetailScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
        fromRec?: string;
    }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);
    const fromRec = typeof params.fromRec === 'string' ? params.fromRec : null;

    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentStatus, setCurrentStatus] = useState<ItemStatus | null>(null);
    // Existing items.rating, if any. Drives the RatingSheet's
    // initialRating so re-rates land on the user's previous pick.
    const [currentRating, setCurrentRating] = useState<number | null>(null);
    const [updating, setUpdating] = useState(false);
    const [showRatingSheet, setShowRatingSheet] = useState(false);
    // All reviews this user is allowed to see for this title (RLS does
    // the gating — author sees own; a friend sees a review only when
    // the parent item is friends-visible AND friendship holds). Own
    // review and friends' reviews live in the same array; the Reviews
    // section splits them in render via myUserId.
    const [reviews, setReviews] = useState<ReviewItem[]>([]);
    const [myUserId, setMyUserId] = useState<string | null>(null);
    // Session-scoped reveal state for spoiler-flagged reviews. Once a
    // user taps "tap to reveal" the row stays open for the rest of the
    // session, but we deliberately don't persist (server-side or
    // locally) — the cover should reappear on a fresh visit so a
    // re-read doesn't auto-spoil.
    const [revealedSpoilers, setRevealedSpoilers] = useState<Set<string>>(
        () => new Set(),
    );
    const [ratingBusy, setRatingBusy] = useState(false);
    const [recContext, setRecContext] = useState<RecContext | null>(null);
    // Aggregated friend activity for the social block. `null` = not yet
    // loaded; an object with empty watchers + 0 ratings = loaded but no
    // friends have any non-private engagement (the renderer hides the
    // whole block in that case).
    const [friendActivity, setFriendActivity] = useState<FriendActivity | null>(
        null,
    );
    // Watch providers for the device's region. `null` covers loading +
    // "no data in this region" + "fetch failed" — all three should render
    // identically (hide the section), so collapsing them into one state
    // keeps the JSX simple.
    const [providersForRegion, setProvidersForRegion] =
        useState<TMDBWatchProvidersRegion | null>(null);
    const region = getRegion();

    // Load title detail (TMDB) and the current library status (Supabase) in
    // parallel. The detail fetch picks getMovie or getTV based on mediaType
    // and wraps the result in the discriminated Detail union so JSX can
    // narrow cleanly downstream.
    useEffect(() => {
        if (!mediaType || !Number.isFinite(tmdbId)) {
            setError('Invalid title');
            setLoading(false);
            return;
        }

        let active = true;

        const detailPromise: Promise<Detail> =
            mediaType === 'movie'
                ? getMovie(tmdbId).then((data) => ({ type: 'movie' as const, data }))
                : getTV(tmdbId).then((data) => ({ type: 'tv' as const, data }));

        // Watch providers fetched in parallel — failure of this call
        // should NOT take down the title screen, so it's swallowed to
        // `null` (which the renderer treats as "hide the section").
        const watchProvidersPromise = (
            mediaType === 'movie'
                ? getMovieWatchProviders(tmdbId)
                : getTVWatchProviders(tmdbId)
        )
            .then((result) => result.results[region] ?? null)
            .catch((err) => {
                console.warn('watch providers fetch failed:', err);
                return null;
            });

        (async () => {
            try {
                const [resolvedDetail, sessionResult, resolvedProviders] =
                    await Promise.all([
                        detailPromise,
                        supabase.auth.getSession(),
                        watchProvidersPromise,
                    ]);
                if (!active) return;
                setDetail(resolvedDetail);
                setProvidersForRegion(resolvedProviders);

                const userId = sessionResult.data.session?.user.id;
                if (userId) {
                    const { data: item } = await supabase
                        .from('items')
                        .select('status, rating')
                        .eq('user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle();
                    if (!active) return;
                    if (item && STATUSES.includes(item.status as ItemStatus)) {
                        setCurrentStatus(item.status as ItemStatus);
                    }
                    if (item && typeof item.rating === 'number') {
                        setCurrentRating(item.rating);
                    }
                }

                // Always-on rec attribution: load every recommendation this
                // user has received for this title (any non-dismissed
                // status — pending / accepted / watched) and surface the
                // sender list. The fromRec query param, when present, just
                // pins which rec's note to display below the senders;
                // without it we show senders without a note. Failures here
                // are silent — the rest of the screen renders fine.
                if (userId) {
                    const { data: recRows, error: recsError } = await supabase
                        .from('recommendations')
                        .select('from_user_id, sent_at')
                        .eq('to_user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .in('status', ['pending', 'accepted', 'watched'])
                        .order('sent_at', { ascending: false });
                    if (recsError) {
                        console.warn('rec context fetch failed:', recsError);
                    } else if (active && recRows && recRows.length > 0) {
                        // Dedup senders (a single sender might appear twice
                        // if they re-sent after a dismiss — rare but cheap
                        // to guard) preserving the most-recent-first order.
                        const senderIds: string[] = [];
                        const seenIds = new Set<string>();
                        for (const row of recRows) {
                            const sid = row.from_user_id;
                            if (!sid || seenIds.has(sid)) continue;
                            seenIds.add(sid);
                            senderIds.push(sid);
                        }

                        let senders: Sender[] = [];
                        if (senderIds.length > 0) {
                            const { data: profileRows } = await supabase
                                .from('profiles')
                                .select('id, handle, display_name, avatar_url')
                                .in('id', senderIds);
                            const profileById = new Map(
                                (profileRows ?? []).map((p) => [p.id, p]),
                            );
                            senders = senderIds
                                .map((id) => profileById.get(id))
                                .filter(
                                    (
                                        p,
                                    ): p is {
                                        id: string;
                                        handle: string;
                                        display_name: string;
                                        avatar_url: string | null;
                                    } => !!p,
                                )
                                .map((p) => ({
                                    userId: p.id,
                                    handle: p.handle,
                                    displayName: p.display_name,
                                    avatarUrl: p.avatar_url,
                                }));
                        }

                        // Note from the specific rec we arrived via, if any.
                        let note: string | null = null;
                        if (fromRec) {
                            const { data: pinnedRec } = await supabase
                                .from('recommendations')
                                .select('note')
                                .eq('id', fromRec)
                                .maybeSingle();
                            note = pinnedRec?.note ?? null;
                        }

                        if (active && senders.length > 0) {
                            setRecContext({
                                senders,
                                totalCount: senders.length,
                                note,
                            });
                        }
                    }
                }

                // Friend activity: pull every friends-visible items row
                // for this title that isn't mine. RLS scopes the result
                // to friends only; the explicit visibility filter is
                // defence-in-depth. Failure is silent — the social block
                // simply hides.
                if (userId) {
                    const { data: friendRows, error: friendErr } = await supabase
                        .from('items')
                        .select('user_id, status, rating')
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .eq('visibility', 'friends')
                        .neq('user_id', userId);
                    if (friendErr) {
                        console.warn('friend activity fetch failed:', friendErr);
                    } else if (active && friendRows) {
                        const watcherIds: string[] = [];
                        const watcherSeen = new Set<string>();
                        const ratings: number[] = [];
                        for (const row of friendRows) {
                            if (
                                row.status === 'watching' &&
                                row.user_id &&
                                !watcherSeen.has(row.user_id)
                            ) {
                                watcherSeen.add(row.user_id);
                                watcherIds.push(row.user_id);
                            }
                            if (
                                row.status === 'watched' &&
                                typeof row.rating === 'number'
                            ) {
                                ratings.push(row.rating);
                            }
                        }

                        // Resolve watcher profiles in one trip so the
                        // avatar stack carries display name + image.
                        let watcherProfiles: AvatarStackItem[] = [];
                        if (watcherIds.length > 0) {
                            const { data: profileRows } = await supabase
                                .from('profiles')
                                .select('id, display_name, avatar_url')
                                .in('id', watcherIds);
                            const byId = new Map(
                                (profileRows ?? []).map((p) => [p.id, p]),
                            );
                            // Preserve watcherIds order — DB doesn't
                            // promise an order on .in(), so explicit
                            // mapping keeps the stack deterministic.
                            watcherProfiles = watcherIds
                                .map((id) => byId.get(id))
                                .filter(
                                    (
                                        p,
                                    ): p is {
                                        id: string;
                                        display_name: string;
                                        avatar_url: string | null;
                                    } => !!p,
                                )
                                .map((p) => ({
                                    userId: p.id,
                                    displayName: p.display_name,
                                    avatarUrl: p.avatar_url,
                                }));
                        }

                        const ratingsAverage =
                            ratings.length > 0
                                ? ratings.reduce((a, b) => a + b, 0) /
                                  ratings.length
                                : null;

                        if (active) {
                            setFriendActivity({
                                watchers: watcherProfiles,
                                ratingsAverage,
                                ratingsCount: ratings.length,
                            });
                        }
                    }
                }
            } catch (err) {
                if (active) setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId, fromRec]);

    // Refresh ALL reviews for this title on every screen focus.
    // Returning from the /review modal lands here and gets the
    // just-saved body without a manual refresh; the same fetch also
    // populates other users' reviews. RLS does the visibility check
    // (author + friends-of-author when item is friends-visible), so
    // the client sends only the title filter and trusts what comes
    // back — no client-side visibility filtering, by design.
    useFocusEffect(
        useCallback(() => {
            if (!mediaType || !Number.isFinite(tmdbId)) return;
            let active = true;
            (async () => {
                try {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    const userId = session?.user.id;
                    if (!userId || !active) return;
                    setMyUserId(userId);

                    const { data: reviewRows, error: reviewError } =
                        await supabase
                            .from('reviews')
                            .select(
                                'id, user_id, body, contains_spoilers, updated_at',
                            )
                            .eq('tmdb_id', tmdbId)
                            .eq('media_type', mediaType)
                            .order('updated_at', { ascending: false });
                    if (!active) return;
                    if (reviewError) {
                        console.warn('reviews fetch failed:', reviewError);
                        return;
                    }

                    // Batch profile lookup for the distinct author ids,
                    // matching the rec/[recId].tsx comments pattern.
                    // Avoids both a per-row N+1 and the supabase-js
                    // joined-query typing weirdness.
                    const authorIds = Array.from(
                        new Set(
                            (reviewRows ?? [])
                                .map((r) => r.user_id)
                                .filter((id): id is string => !!id),
                        ),
                    );
                    const profileById = new Map<
                        string,
                        { displayName: string; avatarUrl: string | null }
                    >();
                    if (authorIds.length > 0) {
                        const { data: profileRows } = await supabase
                            .from('profiles')
                            .select('id, display_name, avatar_url')
                            .in('id', authorIds);
                        if (!active) return;
                        for (const p of profileRows ?? []) {
                            profileById.set(p.id, {
                                displayName: p.display_name,
                                avatarUrl: p.avatar_url,
                            });
                        }
                    }

                    const items: ReviewItem[] = (reviewRows ?? []).map(
                        (r) => ({
                            id: r.id,
                            userId: r.user_id,
                            body: r.body,
                            containsSpoilers: r.contains_spoilers,
                            updatedAt: r.updated_at,
                            author: profileById.get(r.user_id) ?? null,
                        }),
                    );
                    setReviews(items);
                } catch (err) {
                    console.warn('reviews fetch failed:', err);
                }
            })();
            return () => {
                active = false;
            };
        }, [mediaType, tmdbId]),
    );

    async function setStatus(newStatus: ItemStatus) {
        // Block re-entry: while a status update is in flight, or while the
        // rating sheet is already open / its network call is mid-air,
        // ignore further taps.
        if (updating || ratingBusy || showRatingSheet || !mediaType) return;

        // Tapping the currently-active status toggles it off: delete the
        // items row entirely. A row with no status doesn't exist in our
        // model, and the rating lives on the row, so it goes too.
        if (currentStatus === newStatus) {
            await toggleOff();
            return;
        }

        setUpdating(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Transitions INTO 'watched' stamp watched_at and leave
            // rating alone — the rating sheet that opens after will
            // set it (`rating: undefined` drops the key at JSON
            // serialisation, so supabase-js sends no rating column at
            // all, preserving the existing DB value). Transitions to
            // ANY other status must null both columns:
            //   - `rating` MUST be null when status != 'watched' or
            //     items_rating_only_when_watched_check rejects the
            //     upsert (this was the Watched→Watching bug — the
            //     existing rating from the watched state stuck around
            //     through the upsert and tripped the constraint).
            //   - `watched_at` is cleared so the timestamp doesn't
            //     lie about a show that's no longer watched. The next
            //     watched transition will re-stamp to now.
            const isWatched = newStatus === 'watched';
            const row = {
                user_id: userId,
                tmdb_id: tmdbId,
                media_type: mediaType,
                status: newStatus,
                rating: isWatched ? undefined : null,
                watched_at: isWatched
                    ? new Date().toISOString()
                    : null,
            };

            const { error: upsertError } = await supabase
                .from('items')
                .upsert(row, { onConflict: 'user_id,tmdb_id,media_type' });
            if (upsertError) throw upsertError;

            // Stamp the shared catalogue with this title's TMDB metadata.
            // Non-blocking — `ensureTitle` swallows its own errors. The
            // detail screen is guaranteed to have `detail.data` populated
            // before any status-change button is mountable (render guards
            // on `!detail` above), so the if-guard here is for the type
            // narrower, not a runtime branch the user can reach.
            if (detail) {
                const rawDate =
                    detail.type === 'movie'
                        ? detail.data.release_date
                        : detail.data.first_air_date;
                const titleText =
                    detail.type === 'movie'
                        ? detail.data.title
                        : detail.data.name;
                void ensureTitle({
                    tmdbId,
                    mediaType,
                    title: titleText,
                    posterPath: detail.data.poster_path,
                    releaseDate:
                        typeof rawDate === 'string' && rawDate.length > 0
                            ? rawDate
                            : null,
                    originalLanguage: detail.data.original_language,
                    genreIds: detail.data.genres.map((g) => g.id),
                });
            }

            setCurrentStatus(newStatus);
            if (newStatus === 'watched') {
                setShowRatingSheet(true);
            } else {
                // Mirror the DB null so the rating display + toggle-off
                // confirm guard reflect the post-transition state
                // immediately instead of carrying the stale watched
                // rating into the new status.
                setCurrentRating(null);
            }
        } catch (err) {
            console.error('items upsert failed:', err);
            surfaceUpdateError(err);
        } finally {
            setUpdating(false);
        }
    }

    // Toggle-off path for setStatus: delete the items row entirely. Only
    // 'watched' with a rating prompts a confirm — watchlist and watching
    // have no rating to lose (items_rating_only_when_watched_check),
    // and silent removal avoids tap-friction for the common case.
    async function toggleOff() {
        if (!mediaType) return;

        if (currentStatus === 'watched' && currentRating !== null) {
            const confirmed = await new Promise<boolean>((resolve) => {
                Alert.alert(
                    'Remove from library?',
                    'This deletes the show from your library and loses your rating.',
                    [
                        {
                            text: 'Cancel',
                            style: 'cancel',
                            onPress: () => resolve(false),
                        },
                        {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => resolve(true),
                        },
                    ],
                    { cancelable: true, onDismiss: () => resolve(false) },
                );
            });
            if (!confirmed) return;
        }

        setUpdating(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error } = await supabase
                .from('items')
                .delete()
                .eq('user_id', userId)
                .eq('tmdb_id', tmdbId)
                .eq('media_type', mediaType);
            if (error) throw error;

            setCurrentStatus(null);
            setCurrentRating(null);
        } catch (err) {
            console.error('items delete failed:', err);
            surfaceUpdateError(err);
        } finally {
            setUpdating(false);
        }
    }

    // Apply a 1-5 star rating (or skip with `null`) after a watched
    // transition. Database writes (items.rating, matching-rec status
    // transitions) are delegated to applyWatchedRating in lib/rating.
    async function handleRate(rating: number | null) {
        if (ratingBusy || !mediaType) return;
        setRatingBusy(true);
        // Close the sheet immediately so the UI doesn't trap the user
        // behind a spinner if the network is slow. Errors surface via
        // Alert; success is silent.
        setShowRatingSheet(false);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            await applyWatchedRating({ userId, tmdbId, mediaType, rating });
            // Track locally so a subsequent re-rate pre-fills the sheet.
            // Skip (rating === null) leaves the previous value alone —
            // applyWatchedRating doesn't clear it on the items row.
            if (rating !== null) setCurrentRating(rating);
        } catch (err) {
            console.error('rating update failed:', err);
            surfaceUpdateError(err);
        } finally {
            setRatingBusy(false);
        }
    }

    // Shared error surfacing: PostgrestError fields land in Metro logs;
    // user sees message + hint in an Alert. Plain-Error path also covered.
    function surfaceUpdateError(err: unknown) {
        if (err && typeof err === 'object' && 'message' in err) {
            const supaErr = err as {
                message: string;
                details?: string;
                hint?: string;
                code?: string;
            };
            Alert.alert(
                'Update failed',
                `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
            );
        } else {
            Alert.alert('Update failed', String(err));
        }
    }

    // Modal presentation sits below the status bar already, so we
    // don't add `insets.top` — that would push the X well into the
    // hero image. A flat spacing.base sits just inside the modal's
    // rounded top-right corner without clipping.
    const closeButtonTop = spacing.base;

    if (loading) {
        return (
            <View
                style={[styles.root, styles.fillCenter, { backgroundColor: palette.bg }]}
            >
                <ActivityIndicator color={palette.accent} />
                <CloseButton
                    top={closeButtonTop}
                    bg={palette.overlay}
                    fg={palette.textInverse}
                    onPress={router.back}
                />
            </View>
        );
    }

    if (error || !detail) {
        return (
            <View
                style={[styles.root, styles.fillCenter, { backgroundColor: palette.bg }]}
            >
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    {error ?? 'Title not available'}
                </Text>
                <CloseButton
                    top={closeButtonTop}
                    bg={palette.overlay}
                    fg={palette.textInverse}
                    onPress={router.back}
                />
            </View>
        );
    }

    const title = detail.type === 'movie' ? detail.data.title : detail.data.name;
    const dateField =
        detail.type === 'movie' ? detail.data.release_date : detail.data.first_air_date;
    const year = dateField ? dateField.slice(0, 4) : '';
    const extraMeta =
        detail.type === 'movie'
            ? detail.data.runtime
                ? `${detail.data.runtime} min`
                : ''
            : `${detail.data.number_of_seasons} season${
                  detail.data.number_of_seasons === 1 ? '' : 's'
              }`;
    const metaLine = [year, extraMeta].filter(Boolean).join(' · ');

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
                {recContext && (
                    <View
                        style={[
                            styles.recContextCard,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    >
                        <Avatar
                            avatarUrl={recContext.senders[0].avatarUrl}
                            displayName={recContext.senders[0].displayName}
                            seedId={recContext.senders[0].userId}
                            size={36}
                        />
                        <View style={styles.recContextText}>
                            <Text
                                style={[typography.caption, { color: palette.text }]}
                                numberOfLines={2}
                            >
                                {formatSenderLine(recContext.senders)}
                            </Text>
                            {recContext.note && (
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.recContextNote,
                                        { color: palette.textMuted },
                                    ]}
                                    numberOfLines={3}
                                >
                                    “{recContext.note}”
                                </Text>
                            )}
                        </View>
                    </View>
                )}

                {/* Backdrop with a gradient fade at the bottom so the
                    seam between image and the surrounding content blends. */}
                <View style={styles.backdropContainer}>
                    {detail.data.backdrop_path ? (
                        <Image
                            source={{
                                uri: imageUrl(detail.data.backdrop_path, 'w780'),
                            }}
                            style={styles.backdrop}
                            contentFit="cover"
                            transition={200}
                        />
                    ) : (
                        <View
                            style={[
                                styles.backdrop,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                        />
                    )}
                    <LinearGradient
                        colors={['transparent', palette.bg]}
                        style={styles.backdropGradient}
                    />
                </View>

                {/* Poster overlaps the backdrop bottom; the title block
                    sits next to it. negative marginTop pulls the row up
                    onto the backdrop. */}
                <View style={styles.titleBlock}>
                    {detail.data.poster_path ? (
                        <Image
                            source={{
                                uri: imageUrl(detail.data.poster_path, 'w342'),
                            }}
                            style={styles.poster}
                            contentFit="cover"
                            transition={200}
                        />
                    ) : (
                        <View
                            style={[
                                styles.poster,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                        />
                    )}
                    <View style={styles.titleText}>
                        <Text
                            style={[typography.display, { color: palette.text }]}
                            numberOfLines={3}
                        >
                            {title}
                        </Text>
                        {metaLine ? (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {metaLine}
                            </Text>
                        ) : null}
                    </View>
                </View>

                {detail.data.tagline ? (
                    <Text
                        style={[
                            styles.tagline,
                            typography.body,
                            { color: palette.textMuted, fontStyle: 'italic' },
                        ]}
                    >
                        {detail.data.tagline}
                    </Text>
                ) : null}

                {detail.data.genres.length > 0 && (
                    <View style={styles.genres}>
                        {detail.data.genres.map((g) => (
                            <View
                                key={g.id}
                                style={[
                                    styles.genrePill,
                                    { backgroundColor: palette.surfaceAlt },
                                ]}
                            >
                                <Text
                                    style={[typography.micro, { color: palette.text }]}
                                >
                                    {g.name}
                                </Text>
                            </View>
                        ))}
                    </View>
                )}

                {detail.data.overview ? (
                    <Text
                        style={[styles.overview, typography.body, { color: palette.text }]}
                    >
                        {detail.data.overview}
                    </Text>
                ) : null}

                <FriendActivitySection
                    activity={friendActivity}
                    palette={palette}
                />

                <ReviewsSection
                    reviews={reviews}
                    myUserId={myUserId}
                    canWrite={currentStatus === 'watched'}
                    revealedSpoilers={revealedSpoilers}
                    onReveal={(reviewId) =>
                        setRevealedSpoilers((prev) => {
                            const next = new Set(prev);
                            next.add(reviewId);
                            return next;
                        })
                    }
                    onOpenWriteModal={() =>
                        router.push(`/title/${mediaType}/${tmdbId}/review`)
                    }
                    palette={palette}
                />

                <WhereToWatch
                    region={region}
                    providers={providersForRegion}
                    palette={palette}
                />

                {/* YOUR row — singular personal marker for this title.
                    Tappable when the current status is 'watched' so the
                    user can edit (or first-set) their rating without
                    going through the toggle-off / status pill flow. */}
                {currentStatus !== null && (
                    <Pressable
                        onPress={() => {
                            if (currentStatus === 'watched') {
                                setShowRatingSheet(true);
                            }
                        }}
                        disabled={currentStatus !== 'watched'}
                        style={({ pressed }) => [
                            styles.yourMarker,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.text },
                            ]}
                        >
                            {formatYourMarker(currentStatus, currentRating)}
                        </Text>
                        {currentStatus === 'watched' && (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {currentRating !== null
                                    ? 'Tap to edit'
                                    : 'Tap to rate'}
                            </Text>
                        )}
                    </Pressable>
                )}

                {/* Status pills — a choice. The selected status is
                    filled accent; the others are outline-only with a
                    muted border so they read as "available options",
                    distinct from the primary Recommend action below. */}
                <View style={styles.actions}>
                    {STATUSES.map((status) => {
                        const isActive = currentStatus === status;
                        return (
                            <Pressable
                                key={status}
                                onPress={() => setStatus(status)}
                                disabled={updating}
                                style={({ pressed }) => [
                                    styles.actionButton,
                                    {
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed || updating ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        {
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {STATUS_LABELS[status]}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>

                {/* Recommend — a primary outgoing action. Filled accent
                    (vs. the outlined status pills above) so the visual
                    hierarchy reads "pick where this sits in your
                    library, then send it to a friend". */}
                <Pressable
                    onPress={() =>
                        router.push(`/title/${mediaType}/${tmdbId}/recommend`)
                    }
                    style={({ pressed }) => [
                        styles.recommendButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Send
                        color={palette.textInverse}
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Recommend to a friend
                    </Text>
                </Pressable>
            </ScrollView>

            <CloseButton
                top={closeButtonTop}
                bg={palette.overlay}
                fg={palette.textInverse}
                onPress={router.back}
            />

            <RatingSheet
                visible={showRatingSheet}
                busy={ratingBusy}
                initialRating={currentRating}
                onSubmit={handleRate}
            />
        </View>
    );
}

function CloseButton({
    top,
    bg,
    fg,
    onPress,
}: {
    top: number;
    bg: string;
    fg: string;
    onPress: () => void;
}) {
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.sm}
            style={[styles.closeButton, { top, backgroundColor: bg }]}
        >
            <X color={fg} size={20} strokeWidth={ICON_STROKE_WIDTH} />
        </Pressable>
    );
}

// Reviews list under a "Reviews" heading. Combines the user's own
// review (with tap-to-edit) and friends' reviews into a single
// chronologically-aware list (own first if present, then others by
// updated_at desc — the load query already orders desc, so we just
// hoist own to the front in the render).
//
// Hidden entirely when there are no reviews to show AND the user
// can't write one (not 'watched'). When the user can write but
// hasn't yet, a "Write a review" link appears as the first row.
//
// Spoiler handling: for non-own reviews flagged contains_spoilers,
// the body is replaced with a "May contain spoilers — tap to reveal"
// cover until tapped. The user's own review is exempt — they wrote
// it, they know the spoilers. Reveal state is session-only via the
// parent's revealedSpoilers Set.
function ReviewsSection({
    reviews,
    myUserId,
    canWrite,
    revealedSpoilers,
    onReveal,
    onOpenWriteModal,
    palette,
}: {
    reviews: ReviewItem[];
    myUserId: string | null;
    canWrite: boolean;
    revealedSpoilers: Set<string>;
    onReveal: (reviewId: string) => void;
    onOpenWriteModal: () => void;
    palette: ReturnType<typeof getPalette>;
}) {
    const ownReview = myUserId
        ? reviews.find((r) => r.userId === myUserId) ?? null
        : null;
    const others = myUserId
        ? reviews.filter((r) => r.userId !== myUserId)
        : reviews;
    const ordered = ownReview ? [ownReview, ...others] : others;

    if (ordered.length === 0 && !canWrite) {
        return null;
    }

    return (
        <View style={styles.reviewsSection}>
            <Text
                style={[
                    typography.micro,
                    styles.reviewsHeading,
                    { color: palette.textMuted },
                ]}
            >
                REVIEWS
            </Text>
            {canWrite && !ownReview ? (
                <Pressable
                    onPress={onOpenWriteModal}
                    style={({ pressed }) => [
                        styles.writeReviewLink,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.accent },
                        ]}
                    >
                        Write a review
                    </Text>
                </Pressable>
            ) : null}
            {ordered.map((r) => {
                const isOwn = !!myUserId && r.userId === myUserId;
                const revealed = revealedSpoilers.has(r.id);
                const shouldHide = !isOwn && r.containsSpoilers && !revealed;
                const tapAction = isOwn
                    ? onOpenWriteModal
                    : shouldHide
                        ? () => onReveal(r.id)
                        : undefined;
                return (
                    <Pressable
                        key={r.id}
                        onPress={tapAction}
                        disabled={!tapAction}
                        style={({ pressed }) => [
                            styles.reviewCard,
                            { borderColor: palette.border },
                            pressed && tapAction && { opacity: 0.6 },
                        ]}
                    >
                        <View style={styles.reviewHeaderRow}>
                            <Avatar
                                avatarUrl={r.author?.avatarUrl ?? null}
                                displayName={
                                    r.author?.displayName ?? 'Former user'
                                }
                                seedId={r.userId}
                                size={32}
                            />
                            <View style={styles.reviewHeaderText}>
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {isOwn
                                        ? 'You'
                                        : r.author?.displayName ?? 'Former user'}
                                </Text>
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {reviewTimestamp(r.updatedAt)}
                                </Text>
                            </View>
                        </View>
                        {shouldHide ? (
                            <Text
                                style={[
                                    typography.body,
                                    styles.reviewSpoilerCover,
                                    { color: palette.textMuted },
                                ]}
                            >
                                May contain spoilers — tap to reveal
                            </Text>
                        ) : (
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.text },
                                ]}
                            >
                                {r.body}
                            </Text>
                        )}
                        {isOwn ? (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Tap to edit
                            </Text>
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

// Social signal block — friends watching + a one-line ratings summary.
// Hidden entirely when no friend has any non-private engagement (no
// "Friends" header sitting over an empty section). Watchers and
// ratings each get their own row; both can render, either can render
// alone, neither = block is null.
function FriendActivitySection({
    activity,
    palette,
}: {
    activity: FriendActivity | null;
    palette: Palette;
}) {
    if (!activity) return null;
    const { watchers, ratingsAverage, ratingsCount } = activity;
    if (watchers.length === 0 && ratingsCount === 0) return null;

    // Watcher caption: "Jane watching", "Jane & Bob watching",
    // "Jane, Bob & N others watching". Mirrors the rec-sender line
    // pattern used at the top of this screen for consistency.
    let watcherCaption = '';
    if (watchers.length > 0) {
        const names = watchers.map((w) => firstName(w.displayName));
        const verb = 'watching';
        if (names.length === 1) {
            watcherCaption = `${names[0]} ${verb}`;
        } else if (names.length === 2) {
            watcherCaption = `${names[0]} & ${names[1]} ${verb}`;
        } else {
            const others = names.length - 2;
            watcherCaption = `${names[0]}, ${names[1]} & ${others} other${
                others === 1 ? '' : 's'
            } ${verb}`;
        }
    }

    // Ratings summary: convert the mean stored 1-10 value to stars (÷2)
    // with one decimal. Suppress the trailing .0 (e.g. 4★ not 4.0★) so
    // round-number averages read cleanly.
    let ratingsCaption = '';
    if (ratingsAverage !== null && ratingsCount > 0) {
        const stars = ratingsAverage / 2;
        const starsLabel = Number.isInteger(stars)
            ? `${stars}★`
            : `${stars.toFixed(1)}★`;
        ratingsCaption = `Friends · ${starsLabel} avg · ${ratingsCount} rated`;
    }

    return (
        <View style={styles.friendActivity}>
            <Text
                style={[
                    typography.micro,
                    styles.friendActivityHeading,
                    { color: palette.textMuted },
                ]}
            >
                FRIENDS
            </Text>
            {watchers.length > 0 && (
                <View style={styles.friendActivityRow}>
                    <AvatarStack
                        items={watchers}
                        limit={5}
                        size={28}
                        overlap={10}
                        borderColor={palette.bg}
                    />
                    <Text
                        style={[
                            typography.caption,
                            styles.friendActivityCaption,
                            { color: palette.text },
                        ]}
                        numberOfLines={2}
                    >
                        {watcherCaption}
                    </Text>
                </View>
            )}
            {ratingsCaption !== '' && (
                <Text
                    style={[typography.caption, { color: palette.textMuted }]}
                >
                    {ratingsCaption}
                </Text>
            )}
        </View>
    );
}

// "Where to watch" — TMDB watch providers (JustWatch data).
//
// Compliance notes (read before touching this component):
//   - Logos are non-interactive (purely decorative identifiers). TMDB's
//     terms forbid fabricating direct deep links into individual provider
//     apps from this data.
//   - The only outbound link goes to `providers.link` (TMDB's JustWatch
//     deep link for the title in the user's region). Do NOT replace this
//     with a URL we construct ourselves.
//   - The "data provided by JustWatch" attribution caption must remain
//     visible whenever this data is rendered.
//   - Renders nothing when the region has no providers — explicitly NOT
//     a "not available in your region" message; an empty section is
//     dropped cleanly so the layout doesn't acquire a useless heading.
type Palette = ReturnType<typeof getPalette>;

function WhereToWatch({
    region,
    providers,
    palette,
}: {
    region: string;
    providers: TMDBWatchProvidersRegion | null;
    palette: Palette;
}) {
    if (!providers) return null;
    const flatrate = providers.flatrate ?? [];
    const rent = providers.rent ?? [];
    const buy = providers.buy ?? [];
    if (flatrate.length === 0 && rent.length === 0 && buy.length === 0) {
        return null;
    }

    function openJustWatch() {
        // Linking.openURL handles browser launch for http(s) URLs. It
        // returns a promise that rejects if the URL is malformed; the
        // tap is fire-and-forget so we just log a warning rather than
        // surface a modal.
        Linking.openURL(providers!.link).catch((err) => {
            console.warn('failed to open JustWatch link:', err);
        });
    }

    return (
        <View style={styles.wtw}>
            <View style={styles.wtwHeaderRow}>
                <Text
                    style={[
                        typography.micro,
                        styles.sectionLabel,
                        { color: palette.textMuted },
                    ]}
                >
                    WHERE TO WATCH
                </Text>
                <Text
                    style={[
                        typography.micro,
                        styles.wtwRegion,
                        {
                            color: palette.textMuted,
                            backgroundColor: palette.surfaceAlt,
                        },
                    ]}
                >
                    {region}
                </Text>
            </View>

            {flatrate.length > 0 && (
                <WhereToWatchGroup
                    label="Stream"
                    providers={flatrate}
                    palette={palette}
                />
            )}
            {rent.length > 0 && (
                <WhereToWatchGroup
                    label="Rent"
                    providers={rent}
                    palette={palette}
                />
            )}
            {buy.length > 0 && (
                <WhereToWatchGroup
                    label="Buy"
                    providers={buy}
                    palette={palette}
                />
            )}

            <Text
                style={[
                    typography.caption,
                    styles.wtwAttribution,
                    { color: palette.textMuted },
                ]}
            >
                Streaming, rental and purchase data provided by JustWatch.
            </Text>

            <Pressable
                onPress={openJustWatch}
                hitSlop={spacing.sm}
                style={({ pressed }) => [
                    styles.wtwCta,
                    { borderColor: palette.border },
                    pressed && { opacity: 0.6 },
                ]}
                accessibilityRole="link"
                accessibilityLabel="See all watch options on JustWatch"
            >
                <Text
                    style={[
                        typography.bodyEmphasis,
                        { color: palette.accent },
                    ]}
                >
                    See all options on JustWatch
                </Text>
                <ExternalLink
                    color={palette.accent}
                    size={16}
                    strokeWidth={ICON_STROKE_WIDTH}
                />
            </Pressable>
        </View>
    );
}

function WhereToWatchGroup({
    label,
    providers,
    palette,
}: {
    label: string;
    providers: { provider_id: number; provider_name: string; logo_path: string; display_priority: number }[];
    palette: Palette;
}) {
    // TMDB returns providers in arbitrary order; display_priority is
    // their recommended ranking (lower = more prominent).
    const ordered = [...providers].sort(
        (a, b) => a.display_priority - b.display_priority,
    );
    return (
        <View style={styles.wtwGroup}>
            <Text
                style={[
                    typography.caption,
                    styles.wtwGroupLabel,
                    { color: palette.text },
                ]}
            >
                {label}
            </Text>
            <View style={styles.wtwLogoRow}>
                {ordered.map((p) => (
                    <View
                        key={p.provider_id}
                        style={[
                            styles.wtwLogoChip,
                            { borderColor: palette.border },
                        ]}
                        accessibilityLabel={p.provider_name}
                        accessible
                    >
                        <Image
                            source={{ uri: imageUrl(p.logo_path, 'original') }}
                            style={styles.wtwLogo}
                            contentFit="cover"
                            transition={150}
                        />
                    </View>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: { alignItems: 'center', justifyContent: 'center' },
    scrollContent: { paddingBottom: spacing.xxl },
    recContextCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginHorizontal: spacing.base,
        marginTop: spacing.md,
        marginBottom: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        borderRadius: radius.md,
    },
    recContextText: {
        flex: 1,
        gap: spacing.xs,
    },
    recContextNote: {
        fontStyle: 'italic',
    },
    backdropContainer: {
        width: '100%',
        height: BACKDROP_HEIGHT,
    },
    backdrop: {
        width: '100%',
        height: '100%',
    },
    backdropGradient: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: BACKDROP_HEIGHT / 2,
    },
    titleBlock: {
        flexDirection: 'row',
        gap: spacing.base,
        paddingHorizontal: spacing.base,
        marginTop: -POSTER_HEIGHT / 2,
    },
    poster: {
        width: POSTER_WIDTH,
        height: POSTER_HEIGHT,
        borderRadius: radius.sm,
    },
    titleText: {
        flex: 1,
        gap: spacing.xs,
        justifyContent: 'flex-end',
        paddingBottom: spacing.sm,
    },
    tagline: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    genres: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    genrePill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    overview: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    sectionLabel: {
        // Consistent micro-caps treatment used by other section labels
        // (Recommend modal mirrors this). Letter-spacing makes the
        // all-caps read as a label rather than a shouty header.
        letterSpacing: 0.5,
    },
    wtw: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        gap: spacing.md,
    },
    wtwHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    wtwRegion: {
        // Pill-styled region badge sitting opposite the section label.
        // surfaceAlt background keeps it quiet against the section.
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radius.full,
        letterSpacing: 0.5,
    },
    wtwGroup: {
        gap: spacing.sm,
    },
    wtwGroupLabel: {
        fontWeight: '600',
    },
    wtwLogoRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    wtwLogoChip: {
        // Square-ish chip wrapping the provider's square logo. Border
        // gives the logos a consistent frame whether their backgrounds
        // are transparent, white, or dark.
        width: 44,
        height: 44,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    wtwLogo: {
        width: '100%',
        height: '100%',
    },
    wtwAttribution: {
        // Required attribution caption. Kept visible and adjacent to the
        // data it credits per TMDB's terms for the watch providers
        // endpoint. Do NOT move into a tooltip or "info" sheet.
        marginTop: spacing.xs,
    },
    wtwCta: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
    friendActivity: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        gap: spacing.sm,
    },
    friendActivityHeading: {
        letterSpacing: 1.2,
    },
    friendActivityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    friendActivityCaption: {
        flex: 1,
    },
    yourMarker: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        gap: spacing.xs,
    },
    // Reviews section — sits between FriendActivity and WhereToWatch
    // so the "social text content" sits with the "social numbers"
    // content. Horizontal inset matches the FriendActivity and YOUR
    // row blocks for visual alignment.
    reviewsSection: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        gap: spacing.sm,
    },
    reviewsHeading: {
        letterSpacing: 1.2,
        marginBottom: spacing.xs,
    },
    writeReviewLink: {
        paddingVertical: spacing.sm,
    },
    reviewCard: {
        gap: spacing.sm,
        paddingVertical: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    reviewHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    reviewHeaderText: {
        flex: 1,
        gap: spacing.xs,
    },
    reviewSpoilerCover: {
        fontStyle: 'italic',
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        marginTop: spacing.md,
    },
    actionButton: {
        flex: 1,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    recommendButton: {
        // Filled accent — the border that lived here when the button
        // was outlined is gone; the background colour now defines the
        // edge.
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: spacing.base,
        marginTop: spacing.md,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    closeButton: {
        position: 'absolute',
        // Top-right per design — when a rec attribution banner is
        // shown at the top of the scroll, the avatar sits on the left
        // and the close X belongs on the opposite side.
        right: spacing.base,
        width: 36,
        height: 36,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
});
