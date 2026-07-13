import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
    ExternalLink,
    MessageCircle,
    MoreHorizontal,
    Play,
    Send,
    X,
} from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
    Alert,
    Dimensions,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { LoadError } from '@/components/load-error';
import { AvatarStack } from '@/components/avatar-stack';
import { EpisodeProgress } from '@/components/episode-progress';
import { RatingSheet } from '@/components/rating-sheet';
import { Toggle } from '@/components/toggle';
import {
    WatchersSheet,
    type WatcherSheetItem,
} from '@/components/watchers-sheet';
import {
    formatYourMarker,
    setItemVisibility,
    type ItemStatus,
    type ItemVisibility,
} from '@/lib/item-status';
import { OverlapBanner } from '@/components/overlap-banner';
import { goToChatAboutTitle, quickSendAboutTitle } from '@/lib/chat-nav';
import { getFriendsWhoWatched } from '@/lib/friend-activity';
import { LANGUAGE_NAMES } from '@/lib/languages';
import { getRegion } from '@/lib/locale';
import { getReceivedRecsForTitle } from '@/lib/recs';
import { formatRatingStars, ratingGlyphs, type MediaType } from '@/lib/rating';
import { UserLink } from '@/components/user-link';
import { goToProfile } from '@/lib/profile-nav';
import { promptReport } from '@/lib/report';
import supabase from '@/lib/supabase';
import { ensureTitle } from '@/lib/titles';
import {
    getMovie,
    getMovieWatchProviders,
    selectTrailerKey,
    getTV,
    getTVWatchProviders,
    imageUrl,
    type TMDBCastMember,
    type TMDBCrewMember,
    type TMDBMovie,
    type TMDBTV,
    type TMDBWatchProvider,
    type TMDBWatchProvidersRegion,
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
// Backdrop band — ~36% of screen height (up from 32%: the art was cropped
// tight, with the poster row sitting high over it). Still deliberately
// SHORTER than the rec view's full-bleed ~50% header so the two heroes read
// as distinct: there the title sits ON the image; here the image is a band
// the poster straddles, with the title beside it on the plum page.
const BACKDROP_HEIGHT = Math.round(Dimensions.get('window').height * 0.36);
const POSTER_WIDTH = 100;
const POSTER_HEIGHT = 150;
// Trailer play badge on the hero: an invitation to tap the image, not a
// button sitting on top of it — small, and translucent so the art shows
// through. PLAY_BADGE_ALPHA is a hex-alpha suffix appended to the accent
// (both schemes' accents are 6-digit hex): 'B3' ≈ 70%. Tune size/alpha here.
const PLAY_BADGE_SIZE = 40;
const PLAY_BADGE_ALPHA = 'B3';
// Backdrop fade stops, derived from the same geometry as the hero row: the
// title block is top-aligned with the poster, whose top edge sits
// POSTER_HEIGHT/2 above the band's bottom (the straddle offset). END places
// full page-bg a small cushion ABOVE that line so the title always lands on
// clean ground on every screen size — not on a half-faded photo. START keeps
// a ~45%-of-band ramp above it so the fade stays gradual, clamped so tiny
// screens can't push it negative. expo-linear-gradient fills everything after
// the last stop with the last colour, so below END is solid bg.
const HERO_GRADIENT_END =
    (BACKDROP_HEIGHT - POSTER_HEIGHT / 2 - spacing.sm) / BACKDROP_HEIGHT;
const HERO_GRADIENT_START = Math.max(0.1, HERO_GRADIENT_END - 0.45);

interface Sender {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

// One recommender of this title to the current user, with their note —
// rendered as a card in the "Recommended by" section. One entry per
// distinct sender (deduped, most-recent-rec first); `note` is that
// sender's most-recent rec note (null when they sent without one).
interface RecAttribution {
    sender: Sender;
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
    // The author's stored 1-10 rating for this title (items.rating),
    // merged in by user_id. null when they have no rating (watched
    // without rating, or status that can't carry one) — the row then
    // degrades to avatar + name + text with no stars.
    rating: number | null;
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

// "Friends watched this" signal for the title screen. Built ONLY from
// friends whose item on this title is status='watched' AND
// visibility='friends' — privately-watched friends are excluded from
// both the avatars and the average. Privacy is enforced by RLS
// (`visibility = 'friends'` for non-self rows) AND filtered explicitly
// in the query as defence in depth. Watchlist/watching are deliberately
// not surfaced here — this card is specifically "who has watched it".
interface FriendActivity {
    // ALL friends with status='watched' (visibility='friends'), most-
    // recent-first — the full privacy-filtered set. Drives the avatar
    // stack + caption AND the watchers sheet (which lists everyone, each
    // with their rating), so card and sheet share one source and can't
    // drift. Carries per-user rating for the sheet rows.
    watchedFriends: WatcherSheetItem[];
    // Mean of stored 1-10 ratings among those SAME watched friends who
    // left a rating (a watched-but-unrated friend still appears in the
    // avatars but doesn't move the average). null when none rated.
    ratingsAverage: number | null;
    ratingsCount: number;
}

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
}

export default function TitleDetailScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
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

    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    // Bumped by the error screen's "Try again" to re-fire the detail load
    // (it's a dependency of the load effect below).
    const [reloadKey, setReloadKey] = useState(0);
    const [currentStatus, setCurrentStatus] = useState<ItemStatus | null>(null);
    // Existing items.rating, if any. Drives the RatingSheet's
    // initialRating so re-rates land on the user's previous pick.
    const [currentRating, setCurrentRating] = useState<number | null>(null);
    // The item's privacy setting (items.visibility). Defaults to 'friends'
    // (the column default); only meaningful once the title is in the
    // user's library (currentStatus !== null), which gates the control.
    const [currentVisibility, setCurrentVisibility] =
        useState<ItemVisibility>('friends');
    // Persisted episode progress for a TV item (null = not tracked yet). Only
    // surfaced while status === 'watching'; kept in the data across status
    // changes. Feeds EpisodeProgress's initial values.
    const [progressSeason, setProgressSeason] = useState<number | null>(null);
    const [progressEpisode, setProgressEpisode] = useState<number | null>(null);
    const [visibilityBusy, setVisibilityBusy] = useState(false);
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
    // Recommenders of this title to the current user (avatar + name + note),
    // shown as cards in the "Recommended by" section. null = not yet loaded
    // / none. Loaded in the main effect regardless of how the user arrived.
    const [recCards, setRecCards] = useState<RecAttribution[] | null>(null);
    // Aggregated friend activity for the social block. `null` = not yet
    // loaded; an object with empty watchers + 0 ratings = loaded but no
    // friends have any non-private engagement (the renderer hides the
    // whole block in that case).
    const [friendActivity, setFriendActivity] = useState<FriendActivity | null>(
        null,
    );
    // Watchers bottom sheet (full list behind the friends-watched card).
    const [showWatchersSheet, setShowWatchersSheet] = useState(false);
    // Overlap whisper (chat-about-it 3b): watchers fetched fire-and-forget
    // after a successful add-to-watchlist. Data and banner visibility are
    // separate so tapping the banner can hide it while the picker sheet
    // keeps consuming the same list.
    const [overlapWatchers, setOverlapWatchers] = useState<
        WatcherSheetItem[] | null
    >(null);
    const [overlapBannerVisible, setOverlapBannerVisible] = useState(false);
    const [showOverlapPicker, setShowOverlapPicker] = useState(false);
    // Friends currently WATCHING this title (status='watching',
    // visibility='friends', excludes me) — the parallel signal to
    // friendActivity's watched set. Same WatcherSheetItem shape; `rating`
    // is always null here (the items check constraint forbids a rating
    // unless status='watched'). `null` = not yet loaded; [] = loaded,
    // nobody watching (renderer hides the card).
    const [friendsWatching, setFriendsWatching] = useState<
        WatcherSheetItem[] | null
    >(null);
    // Sheet behind the friends-watching card (same WatchersSheet component,
    // title="Watching").
    const [showWatchingSheet, setShowWatchingSheet] = useState(false);
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

        // appendCredits + appendVideos fold the cast list and the trailer list
        // into the same TMDB round-trip as the detail fetch (via
        // append_to_response=credits,videos) — the cast row renders from
        // detail.data.credits.cast, the trailer from detail.data.videos.
        const detailPromise: Promise<Detail> =
            mediaType === 'movie'
                ? getMovie(tmdbId, {
                      appendCredits: true,
                      appendVideos: true,
                  }).then((data) => ({
                      type: 'movie' as const,
                      data,
                  }))
                : getTV(tmdbId, {
                      appendCredits: true,
                      appendVideos: true,
                  }).then((data) => ({
                      type: 'tv' as const,
                      data,
                  }));

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
                    const { data: itemRow } = await supabase
                        .from('items')
                        .select(
                            'status, rating, visibility, progress_season, progress_episode',
                        )
                        .eq('user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle();
                    if (!active) return;
                    // reason: progress_season / progress_episode come from the
                    // pending migration (20260707120000) and aren't in the
                    // generated Supabase types yet; cast to the runtime shape.
                    const item = itemRow as unknown as {
                        status: string | null;
                        rating: number | null;
                        visibility: string | null;
                        progress_season: number | null;
                        progress_episode: number | null;
                    } | null;
                    if (item && STATUSES.includes(item.status as ItemStatus)) {
                        setCurrentStatus(item.status as ItemStatus);
                    }
                    if (item && typeof item.rating === 'number') {
                        setCurrentRating(item.rating);
                    }
                    if (item && item.visibility === 'private') {
                        setCurrentVisibility('private');
                    }
                    if (item && typeof item.progress_season === 'number') {
                        setProgressSeason(item.progress_season);
                    }
                    if (item && typeof item.progress_episode === 'number') {
                        setProgressEpisode(item.progress_episode);
                    }
                }

                // Always-on rec attribution: load every recommendation this
                // user has received for this title (any non-dismissed
                // status — pending / accepted / watched) and build one card
                // per recommender (avatar + name + note). Runs regardless of
                // how the user arrived. Failures here are silent — the rest
                // of the screen renders fine.
                if (userId) {
                    try {
                        const received = await getReceivedRecsForTitle(
                            userId,
                            tmdbId,
                            mediaType,
                        );
                        if (active && received.length > 0) {
                            setRecCards(
                                received.map((r) => ({
                                    sender: {
                                        userId: r.fromUserId,
                                        handle: r.sender.handle,
                                        displayName: r.sender.displayName,
                                        avatarUrl: r.sender.avatarUrl,
                                    },
                                    note: r.note,
                                })),
                            );
                        }
                    } catch (err) {
                        console.warn('rec context fetch failed:', err);
                    }
                }

                // Friends-watched: extracted to getFriendsWhoWatched (the
                // overlap banner + watcher-picker reuse it) — same privacy
                // contract as before (status='watched', visibility='friends',
                // RLS friend scope; privately-watched friends excluded from
                // avatars AND average). Failure is silent — the card simply
                // hides. Ratings average is computed here over the SAME
                // returned set, exactly as the inline version did.
                if (userId) {
                    try {
                        const watchedFriends = await getFriendsWhoWatched(
                            userId,
                            tmdbId,
                            mediaType,
                        );
                        const ratings = watchedFriends
                            .map((w) => w.rating)
                            .filter((r): r is number => r !== null);
                        const ratingsAverage =
                            ratings.length > 0
                                ? ratings.reduce((a, b) => a + b, 0) /
                                  ratings.length
                                : null;
                        if (active) {
                            setFriendActivity({
                                watchedFriends,
                                ratingsAverage,
                                ratingsCount: ratings.length,
                            });
                        }
                    } catch (err) {
                        console.warn('friend activity fetch failed:', err);
                    }
                }

                // Friends-watching: the parallel query to the watched block
                // above — IDENTICAL privacy contract (RLS scopes non-self
                // rows to actual friends AND visibility='friends'; the
                // explicit filter here is the same defence-in-depth, so a
                // privately-watching friend never shows), with only the
                // status value differing. Deliberately self-contained (own
                // profiles fetch) so the watched path stays byte-identical;
                // merging the two profile lookups is a later optimisation.
                // No rating selected — the items check constraint forbids a
                // rating unless status='watched'. Failure is silent, same
                // as the watched card.
                if (userId) {
                    const { data: watchingRows, error: watchingErr } =
                        await supabase
                            .from('items')
                            .select('user_id, updated_at')
                            .eq('tmdb_id', tmdbId)
                            .eq('media_type', mediaType)
                            .eq('status', 'watching')
                            .eq('visibility', 'friends')
                            .neq('user_id', userId)
                            .order('updated_at', { ascending: false });
                    if (watchingErr) {
                        console.warn(
                            'friends-watching fetch failed:',
                            watchingErr,
                        );
                    } else if (active && watchingRows) {
                        const watchingIds: string[] = [];
                        const seenWatching = new Set<string>();
                        for (const row of watchingRows) {
                            if (!row.user_id || seenWatching.has(row.user_id)) {
                                continue;
                            }
                            seenWatching.add(row.user_id);
                            watchingIds.push(row.user_id);
                        }
                        let watching: WatcherSheetItem[] = [];
                        if (watchingIds.length > 0) {
                            const { data: profileRows } = await supabase
                                .from('profiles')
                                .select('id, handle, display_name, avatar_url')
                                .in('id', watchingIds);
                            const byId = new Map(
                                (profileRows ?? []).map((p) => [p.id, p]),
                            );
                            // Preserve most-recent-first (.in() promises no
                            // order) so the lead avatar is the most recent
                            // watcher, matching the watched card.
                            watching = watchingIds
                                .map((id) => byId.get(id))
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
                                    rating: null,
                                }));
                        }
                        if (active) setFriendsWatching(watching);
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
    }, [mediaType, tmdbId, reloadKey]);

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

                    // Per-author rating for this title (items.rating),
                    // keyed by user_id. Same RLS as the reviews: an item
                    // is visible only when it's the viewer's own OR
                    // friends-visible AND a friend — so this never
                    // surfaces a stranger's rating. Absent = the review
                    // row shows no stars.
                    const ratingByUser = new Map<string, number>();
                    if (authorIds.length > 0) {
                        const { data: itemRows } = await supabase
                            .from('items')
                            .select('user_id, rating')
                            .eq('tmdb_id', tmdbId)
                            .eq('media_type', mediaType)
                            .in('user_id', authorIds);
                        if (!active) return;
                        for (const it of itemRows ?? []) {
                            if (typeof it.rating === 'number') {
                                ratingByUser.set(it.user_id, it.rating);
                            }
                        }
                    }

                    const items: ReviewItem[] = (reviewRows ?? []).map(
                        (r) => ({
                            id: r.id,
                            userId: r.user_id,
                            body: r.body,
                            containsSpoilers: r.contains_spoilers,
                            updatedAt: r.updated_at,
                            rating: ratingByUser.get(r.user_id) ?? null,
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
                    backdropPath: detail.data.backdrop_path,
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

            // Overlap whisper (chat-about-it 3b): the add is already
            // committed — fire-and-forget the friends-watched lookup; ≥1
            // watcher → banner. Failure or zero watchers = no banner, never
            // an error. The persistent watchlist_overlap row is the DB
            // trigger's job, independent of this.
            if (newStatus === 'watchlist') {
                void (async () => {
                    try {
                        const watchers = await getFriendsWhoWatched(
                            userId,
                            tmdbId,
                            mediaType,
                        );
                        if (watchers.length > 0) {
                            setOverlapWatchers(watchers);
                            setOverlapBannerVisible(true);
                        }
                    } catch (err) {
                        console.warn('overlap banner lookup failed:', err);
                    }
                })();
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
            // Row is gone; next add re-creates it at the column default.
            setCurrentVisibility('friends');
        } catch (err) {
            console.error('items delete failed:', err);
            surfaceUpdateError(err);
        } finally {
            setUpdating(false);
        }
    }

    // The RatingSheet now owns persistence (rating + rec transitions + note/
    // comment/privacy). Here we only close and reflect the chosen rating
    // locally so a re-rate pre-fills the sheet; skip (rating === null) leaves
    // the previous value alone.
    function handleRate(rating: number | null) {
        setShowRatingSheet(false);
        if (rating !== null) setCurrentRating(rating);
    }

    // Flip the item's privacy. Optimistic: update local state first, write
    // via the shared setItemVisibility path, revert on failure. Guarded so
    // it's a no-op when the title isn't in the library (no row to update)
    // or a write is already in flight.
    async function handleSetVisibility(next: ItemVisibility) {
        if (visibilityBusy || currentStatus === null || next === currentVisibility) {
            return;
        }
        const previous = currentVisibility;
        setCurrentVisibility(next);
        setVisibilityBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId || !mediaType) throw new Error('Not authenticated');
            await setItemVisibility({
                userId,
                tmdbId,
                mediaType,
                visibility: next,
            });
        } catch (err) {
            setCurrentVisibility(previous);
            console.error('visibility update failed:', err);
            surfaceUpdateError(err);
        } finally {
            setVisibilityBusy(false);
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

    // As a fullScreenModal the title page now covers the status-bar /
    // notch area (the old 'modal' sheet gave that top gap for free), so
    // the close button must clear it via the top safe-area inset. Works
    // on notch + non-notch devices (insets.top is 0 where there's no
    // notch, leaving just the spacing.base gap).
    const closeButtonTop = insets.top + spacing.base;

    if (showLoader) {
        return (
            <View
                style={[styles.root, styles.fillCenter, { backgroundColor: palette.bg }]}
            >
                <FullScreenLoader />
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
        // Friendly fallback — the underlying TMDB error (often a transient
        // upstream 500) is logged, never shown. "Try again" re-fires the load.
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <LoadError
                    title="Couldn't load this title"
                    onRetry={() => {
                        setError(null);
                        setLoading(true);
                        setReloadKey((k) => k + 1);
                    }}
                />
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
    // Original language as a readable name when it's NOT English.
    // English-language titles are the common case in an alpha that's
    // English-speaking — surfacing "English" on every American film
    // is noise. Foreign-language titles get a useful "Japanese" /
    // "Korean" / etc. flag. Name comes from LANGUAGE_NAMES, a static
    // ISO 639-1 → English map (Hermes' Intl.DisplayNames was
    // unreliable across platforms — see the file header on
    // src/lib/languages.ts). An unmapped code is omitted from the
    // meta line; with ~50 entries in the map, that should be rare,
    // and the fix is one map entry away. When 'en' is no longer the
    // assumed default (multi-region launch), swap the filter for a
    // device-locale comparison.
    const code = detail.data.original_language;
    const languageName =
        code && code !== 'en' ? LANGUAGE_NAMES.get(code) ?? '' : '';
    const metaLine = [year, extraMeta, languageName].filter(Boolean).join(' · ');

    // Trailer lives ON the hero now (badge + whole-band tap) instead of a
    // separate row below the meta. Same selection + deep-link behaviour the
    // old TitleTrailer row had; no trailer → plain non-interactive backdrop.
    const trailerKey = selectTrailerKey(detail.data.videos?.results);

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    // Bottom clearance for the last element (the "More details
                    // on JustWatch" button). The static xxl was fixed, so on
                    // Android edge-to-edge it sat under the nav bar. Use the
                    // real inset; Math.max keeps iOS at exactly xxl (insets.
                    // bottom + md is always <= xxl there) while Android gets
                    // nav-bar clearance.
                    {
                        paddingBottom: Math.max(
                            spacing.xxl,
                            insets.bottom + spacing.md,
                        ),
                    },
                ]}
            >
                {/* Backdrop band — shorter than the rec hero. The lower
                    portion fades into the page via a pure ALPHA ramp of
                    the bg colour (bgTransparent → bg, same lesson as the
                    rec view): no grey/pale seam. The ramp completes at
                    HERO_GRADIENT_END — just above the poster's TOP edge —
                    so the top-aligned title beside the poster always sits
                    on solid page bg, and the poster's upper half straddles
                    the fade rather than a hard image edge.

                    When a trailer exists the band doubles as the play
                    control: a 56pt accent badge in the upper region (above
                    the gradient fade and the poster overlap) and the WHOLE
                    band tappable → YouTube deep-link. No trailer → plain
                    View, no affordance. */}
                <Pressable
                    onPress={
                        trailerKey
                            ? () =>
                                  Linking.openURL(
                                      'https://www.youtube.com/watch?v=' +
                                          trailerKey,
                                  )
                            : undefined
                    }
                    disabled={!trailerKey}
                    accessibilityRole={trailerKey ? 'button' : undefined}
                    accessibilityLabel={
                        trailerKey ? 'Play trailer on YouTube' : undefined
                    }
                    style={styles.backdropContainer}
                >
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
                        colors={[palette.bgTransparent, palette.bg]}
                        locations={[HERO_GRADIENT_START, HERO_GRADIENT_END]}
                        style={StyleSheet.absoluteFill}
                    />
                    {trailerKey ? (
                        <View
                            style={[
                                styles.playBadge,
                                {
                                    backgroundColor:
                                        palette.accent + PLAY_BADGE_ALPHA,
                                },
                            ]}
                            pointerEvents="none"
                        >
                            <Play
                                color={palette.textInverse}
                                size={18}
                                strokeWidth={ICON_STROKE_WIDTH}
                                fill={palette.textInverse}
                            />
                        </View>
                    ) : null}
                </Pressable>

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
                            // Secondary reference info — smaller (micro) +
                            // muted so it sits below both the title above
                            // and the "You rated this" status line below,
                            // rather than competing with them.
                            <Text
                                style={[
                                    typography.micro,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {metaLine}
                            </Text>
                        ) : null}
                        {/* YOUR rating — prominent, directly under the meta
                            line and ABOVE the genre chips (the chips are
                            the footnote, not a divider between metadata
                            and rating). Watched + rated: accent glyph
                            stars (the ★★★½ language used app-wide), the
                            stars themselves tappable to re-rate — no
                            pencil; tapping your own rating to change it is
                            the universal pattern. Watched, unrated: five
                            muted stars as the tap-to-rate affordance — an
                            "empty rating" in the same glyph language.
                            Watchlist/watching: the quiet informational
                            caption, unchanged. Deliberately no aggregate/
                            community rating — friends' ratings live in the
                            friends-watched cards only. */}
                        {currentStatus !== null && (
                            <View style={styles.statusLine}>
                                {currentStatus === 'watched' ? (
                                    <Pressable
                                        onPress={() => setShowRatingSheet(true)}
                                        hitSlop={spacing.sm}
                                        accessibilityRole="button"
                                        accessibilityLabel={
                                            currentRating !== null
                                                ? 'Edit your rating'
                                                : 'Rate this'
                                        }
                                        style={({ pressed }) => [
                                            styles.statusEdit,
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        <Text
                                            numberOfLines={1}
                                            style={[
                                                styles.ratingStars,
                                                {
                                                    color:
                                                        currentRating !== null
                                                            ? palette.accent
                                                            : palette.textMuted,
                                                },
                                            ]}
                                        >
                                            {currentRating !== null
                                                ? ratingGlyphs(currentRating)
                                                : '★★★★★'}
                                        </Text>
                                    </Pressable>
                                ) : (
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            typography.caption,
                                            { color: palette.textMuted },
                                        ]}
                                    >
                                        {formatYourMarker(
                                            currentStatus,
                                            currentRating,
                                        ) ?? ''}
                                    </Text>
                                )}
                            </View>
                        )}
                        {/* Genre chips — the title column's last line,
                            under the rating. Non-interactive labels,
                            distinct from the status chips below. */}
                        {detail.data.genres.length > 0 && (
                            <View style={styles.genres}>
                                {detail.data.genres.map((g) => (
                                    <View
                                        key={g.id}
                                        style={[
                                            styles.genrePill,
                                            {
                                                backgroundColor:
                                                    palette.surfaceAlt,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.micro,
                                                { color: palette.text },
                                            ]}
                                        >
                                            {g.name}
                                        </Text>
                                    </View>
                                ))}
                            </View>
                        )}
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

                {/* Movies-only "Directed by / Written by" line.
                    Sourced from the same append_to_response=credits
                    payload that powers the cast row. TV omitted by
                    design: TV directing is per-episode, and a TV
                    equivalent here would use created_by, which is a
                    different field with different semantics. */}
                {detail.type === 'movie' && (
                    <DirectorWriterLine
                        crew={detail.data.credits?.crew}
                        palette={palette}
                        onSelectPerson={(personId) =>
                            router.push({
                                pathname: '/person/[personId]',
                                params: { personId: String(personId) },
                            })
                        }
                    />
                )}

                {/* Synopsis — "what is this", placed ABOVE the cast
                    ("who's in it"). */}
                {detail.data.overview ? (
                    <Text
                        style={[styles.overview, typography.body, { color: palette.text }]}
                    >
                        {detail.data.overview}
                    </Text>
                ) : null}

                {/* Status actions — the SINGLE interactive status control on
                    this screen (the legacy full-width bottom buttons were
                    removed). Borderless, text-only chips: unselected = soft
                    accentWash fill + plum text, selected = solid accent +
                    white. Wired to setStatus — tap to set, re-tap to clear,
                    watched opens the rating sheet. Sits AFTER the synopsis —
                    "track this" is an action that reads best once you've
                    seen what the title is (esp. when discovering via a rec).
                    Its own marginTop/Bottom set it apart as the interactive
                    row between the synopsis and the cast. */}
                <View style={styles.statusChipRow}>
                    {STATUSES.map((status) => {
                        const isActive = currentStatus === status;
                        return (
                            <Pressable
                                key={status}
                                onPress={() => setStatus(status)}
                                hitSlop={spacing.xs}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isActive }}
                                accessibilityLabel={STATUS_LABELS[status]}
                                style={({ pressed }) => [
                                    styles.statusChip,
                                    {
                                        // Borderless: soft plum wash fill
                                        // when unselected, solid accent when
                                        // selected.
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : palette.accentWash,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.statusChipText,
                                        {
                                            // Plum text on the wash; white
                                            // on the selected fill.
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.accent,
                                        },
                                    ]}
                                >
                                    {STATUS_LABELS[status]}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>

                {/* Episode progress — TV only, and only while Watching. One
                    compact stepper row (Season −/+, Episode −/+) under the
                    status control. Progress is kept in the data across status
                    changes but the control is hidden once not Watching. */}
                {detail.type === 'tv' && currentStatus === 'watching' && (
                    <EpisodeProgress
                        tmdbId={tmdbId}
                        initialSeason={progressSeason}
                        initialEpisode={progressEpisode}
                        seasons={detail.data.seasons}
                        numberOfSeasons={detail.data.number_of_seasons}
                    />
                )}

                {/* Sharing card — the sharing group as one semantic unit:
                    who can see this (Visible to friends), and how you
                    share it (Recommend, Chat about it). Same card
                    treatment as the "recommended by"/"watched by" social
                    cards below (surfaceElevated fill, radius.md, no
                    shadow) — NOT white/surface. The status pills above
                    stay OUTSIDE on the wash: they're the user's own
                    private state, not a sharing action. */}
                <View
                    style={[
                        styles.sharingCard,
                        { backgroundColor: palette.surfaceElevated },
                    ]}
                >
                    {/* Visible to friends — the privacy control, an
                        explicit labeled row. Same Toggle component and
                        polarity as the rating sheet: ON = friends can see
                        this title in your activity, OFF = private. Only
                        meaningful once the title is in the library.
                        Optimistic via handleSetVisibility (reverts on
                        failure); toggling to private hides activity, it
                        does NOT remove the title. */}
                    {currentStatus !== null && (
                        <View style={styles.visibilityRow}>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.text },
                                ]}
                            >
                                Visible to friends
                            </Text>
                            <Toggle
                                value={currentVisibility !== 'private'}
                                onValueChange={(v) =>
                                    handleSetVisibility(
                                        v ? 'friends' : 'private',
                                    )
                                }
                                palette={palette}
                                disabled={visibilityBusy}
                            />
                        </View>
                    )}

                    {/* Recommend — a primary outgoing action. Filled accent
                        (vs. the outlined status pills above) so the visual
                        hierarchy reads "pick where this sits in your
                        library, then send it to a friend". */}
                    <Pressable
                        onPress={() =>
                            router.push(
                                `/title/${mediaType}/${tmdbId}/recommend`,
                            )
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

                    {/* Chat with a friend — the casual sibling beneath
                        Recommend. Ghost row: accent icon + label but NO
                        fill/border, so it reads as "quiet but active"
                        (matching the app's other text actions — Cancel,
                        Add by handle, the invite link) while staying
                        clearly subordinate to the filled Recommend
                        primary. The hierarchy is Recommend = the committed
                        act, Chat = the light one — the same primary/
                        secondary pairing as the rec screen's Save over
                        "Not for me". */}
                    <Pressable
                        onPress={() =>
                            router.push(`/title/${mediaType}/${tmdbId}/chat`)
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Chat with a friend"
                        style={({ pressed }) => [
                            styles.chatButton,
                            { opacity: pressed ? 0.6 : 1 },
                        ]}
                    >
                        <MessageCircle
                            color={palette.accent}
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
                            ]}
                        >
                            Chat with a friend
                        </Text>
                    </Pressable>
                </View>

                {/* Where to watch — moved up directly beneath the sharing
                    card (was last, after Reviews). "Where can I watch
                    this" is the first practical question after receiving a
                    rec, so it leads the informational sections rather than
                    making the recipient hunt past Cast + the social cards.
                    Renders nothing when no providers exist for the region,
                    so a no-providers title still leads with Cast as before. */}
                <WhereToWatch
                    region={region}
                    providers={providersForRegion}
                    palette={palette}
                />

                {/* Cast — top ~10 by billing order. Tapping any card
                    routes to the existing /person/[personId] screen so
                    the user stays in-app on the actor's filmography
                    instead of bouncing to TMDB. Section omitted
                    entirely when credits weren't loaded or cast is
                    empty (the && guard handles both). */}
                {detail.data.credits?.cast &&
                    detail.data.credits.cast.length > 0 && (
                        <CastRow
                            cast={detail.data.credits.cast}
                            palette={palette}
                            onSelect={(personId) =>
                                router.push({
                                    pathname: '/person/[personId]',
                                    params: { personId: String(personId) },
                                })
                            }
                        />
                    )}

                {/* Two social cards as a pair: who recommended it to you,
                    then which friends have watched it. */}
                <RecommendedBySection recs={recCards} palette={palette} />

                <FriendActivitySection
                    activity={friendActivity}
                    palette={palette}
                    onPress={() => setShowWatchersSheet(true)}
                />

                {/* Friends currently watching — the live counterpart to the
                    watched card above. Same card treatment; hides itself
                    when nobody's watching (friends-visible). */}
                <FriendsWatchingSection
                    watching={friendsWatching}
                    palette={palette}
                    onPress={() => setShowWatchingSheet(true)}
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
                tmdbId={tmdbId}
                mediaType={mediaType}
                onSubmit={handleRate}
            />

            {/* Full watchers list behind the friends-watched card. Fed the
                SAME privacy-filtered set the card is built from, so the
                sheet can't surface anyone the card excludes. */}
            <WatchersSheet
                visible={showWatchersSheet}
                watchers={friendActivity?.watchedFriends ?? []}
                onClose={() => setShowWatchersSheet(false)}
                onSelectWatcher={(w) => {
                    // Row tap → the friend's profile (browse). Close the
                    // sheet first (avoids pushing under the open modal).
                    setShowWatchersSheet(false);
                    router.push(`/friends/${w.handle}`);
                }}
                // Chat icon = an EXPANDER: reveals this row's chips inline
                // (read-then-tap, no silent send). Same chips as the
                // overlap picker; message chips quick-send, "Write…" opens
                // compose.
                quickChips={{
                    expandable: true,
                    messages: ['Worth watching?', 'What did you think?'],
                    onQuickSend: (w, message) => {
                        setShowWatchersSheet(false);
                        if (mediaType) {
                            void quickSendAboutTitle({
                                otherUserId: w.userId,
                                tmdbId,
                                mediaType,
                                message,
                            });
                        }
                    },
                    onWriteYourOwn: (w) => {
                        setShowWatchersSheet(false);
                        if (mediaType) {
                            void goToChatAboutTitle({
                                otherUserId: w.userId,
                                tmdbId,
                                mediaType,
                            });
                        }
                    },
                }}
            />

            {/* Full list behind the friends-watching card — same sheet
                component, "Watching" heading; rows are starless because
                watching rows can't carry a rating. Fed the same
                privacy-filtered set as the card. */}
            <WatchersSheet
                visible={showWatchingSheet}
                watchers={friendsWatching ?? []}
                title="Watching"
                onClose={() => setShowWatchingSheet(false)}
                onSelectWatcher={(w) => {
                    setShowWatchingSheet(false);
                    router.push(`/friends/${w.handle}`);
                }}
                quickChips={{
                    expandable: true,
                    messages: ['Worth watching?', 'What did you think?'],
                    onQuickSend: (w, message) => {
                        setShowWatchingSheet(false);
                        if (mediaType) {
                            void quickSendAboutTitle({
                                otherUserId: w.userId,
                                tmdbId,
                                mediaType,
                                message,
                            });
                        }
                    },
                    onWriteYourOwn: (w) => {
                        setShowWatchingSheet(false);
                        if (mediaType) {
                            void goToChatAboutTitle({
                                otherUserId: w.userId,
                                tmdbId,
                                mediaType,
                            });
                        }
                    },
                }}
            />

            {/* Overlap whisper after add-to-watchlist. Mounted on THIS
                screen (never root — this page is a presented
                fullScreenModal; a root overlay would render beneath it). */}
            {overlapBannerVisible && overlapWatchers ? (
                <OverlapBanner
                    watchers={overlapWatchers}
                    style={{ bottom: insets.bottom + spacing.lg }}
                    onPress={() => {
                        setOverlapBannerVisible(false);
                        setShowOverlapPicker(true);
                    }}
                    onDismiss={() => setOverlapBannerVisible(false)}
                />
            ) : null}

            {/* Watcher-picker behind the banner (and, later, the inbox
                overlap row): same WatchersSheet, but this is the
                send-a-message flow — each row carries always-visible quick
                chips so a message is one tap. The message chips quick-send
                and land in the thread; "Write…" opens the compose screen
                for custom words. (onSelectWatcher is unused in chip mode —
                the chips are the row's actions.) */}
            <WatchersSheet
                visible={showOverlapPicker}
                watchers={overlapWatchers ?? []}
                onClose={() => setShowOverlapPicker(false)}
                onSelectWatcher={() => {}}
                quickChips={{
                    messages: ['Worth watching?', 'What did you think?'],
                    onQuickSend: (w, message) => {
                        setShowOverlapPicker(false);
                        if (mediaType) {
                            void quickSendAboutTitle({
                                otherUserId: w.userId,
                                tmdbId,
                                mediaType,
                                message,
                            });
                        }
                    },
                    onWriteYourOwn: (w) => {
                        setShowOverlapPicker(false);
                        if (mediaType) {
                            void goToChatAboutTitle({
                                otherUserId: w.userId,
                                tmdbId,
                                mediaType,
                            });
                        }
                    },
                }}
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

// "Directed by / Written by" credit line for the movie title screen.
// One compact caption-styled line sitting between the tagline and the
// genre pills; each name is its own tap target routing to the existing
// /person/[personId] screen (same pattern as the cast row).
//
// Directors: every crew entry with job === 'Director' (most films
// have one; a few — Coens, Wachowskis, Daniels — have two; very rare
// films have more). All shown, joined with ", " and a final " & "
// (mirrors the rec-sender and watcher caption pattern elsewhere on
// this screen).
//
// Writers: crew entries with job in {'Writer', 'Screenplay', 'Story'}.
// Same person can hold multiple writing credits on one film
// (Screenplay + Story is the canonical case for adapted screenplays);
// deduped by id so they appear once. Capped at the first 3 unique
// people so heavily-credited scripts don't run a wall of names into
// the layout. Order is preserved from TMDB, which roughly ranks by
// credit prominence within each job type.
//
// Either side can be empty (rare — some festival/indie entries on
// TMDB lack a Director row, or have all writing credits filed under a
// non-recognised job string). Renders the populated side alone and
// omits the separator; returns null only when both are empty.
function DirectorWriterLine({
    crew,
    palette,
    onSelectPerson,
}: {
    crew?: TMDBCrewMember[];
    palette: Palette;
    onSelectPerson: (personId: number) => void;
}) {
    if (!crew || crew.length === 0) return null;

    const directors = crew.filter((c) => c.job === 'Director');

    const WRITER_JOBS = new Set(['Writer', 'Screenplay', 'Story']);
    const writersById = new Map<number, TMDBCrewMember>();
    for (const c of crew) {
        if (WRITER_JOBS.has(c.job) && !writersById.has(c.id)) {
            writersById.set(c.id, c);
        }
    }
    const writers = Array.from(writersById.values()).slice(0, 3);

    if (directors.length === 0 && writers.length === 0) return null;

    // Render a comma-and-ampersand-joined list of tappable names. Each
    // <Text onPress> is its own per-name tap target rather than wrapping
    // the whole segment, so a user tapping "Coen" on "Joel & Ethan Coen"
    // lands on the right person. Tappable spans take palette.text (not
    // muted) so they read as interactive against the muted surrounding
    // line.
    const renderNames = (people: TMDBCrewMember[]) =>
        people.map((p, i) => (
            <Text key={p.id}>
                {i > 0 && (i === people.length - 1 ? ' & ' : ', ')}
                <Text
                    onPress={() => onSelectPerson(p.id)}
                    style={{ color: palette.text }}
                >
                    {p.name}
                </Text>
            </Text>
        ));

    return (
        <Text
            style={[
                styles.crewLine,
                typography.caption,
                { color: palette.textMuted },
            ]}
            numberOfLines={2}
        >
            {directors.length > 0 ? (
                <>Directed by {renderNames(directors)}</>
            ) : null}
            {directors.length > 0 && writers.length > 0 ? '  ·  ' : null}
            {writers.length > 0 ? (
                <>Written by {renderNames(writers)}</>
            ) : null}
        </Text>
    );
}

// Top-billed cast as a horizontal-scrolling photo row under a "Cast"
// heading. Sourced from append_to_response=credits on the title detail
// fetch (no extra round-trip). Each card taps through to the existing
// /person/[personId] screen, keeping the user in-app on the actor's
// filmography instead of bouncing out. Top 10 by billing order — TMDB
// usually returns cast pre-sorted but the explicit sort guards against
// API surprises. Missing profile_path falls back to a tinted block
// (matches the placeholder pattern this screen uses elsewhere for
// missing posters).
function CastRow({
    cast,
    palette,
    onSelect,
}: {
    cast: TMDBCastMember[];
    palette: Palette;
    onSelect: (personId: number) => void;
}) {
    const top = cast
        .slice()
        .sort((a, b) => a.order - b.order)
        .slice(0, 10);
    if (top.length === 0) return null;
    return (
        <View style={styles.castSection}>
            <Text
                style={[
                    typography.bodyEmphasis,
                    styles.castHeading,
                    { color: palette.text },
                ]}
            >
                Cast
            </Text>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.castScrollContent}
            >
                {top.map((member) => (
                    <Pressable
                        key={member.id}
                        onPress={() => onSelect(member.id)}
                        style={({ pressed }) => [
                            styles.castCell,
                            pressed && { opacity: 0.6 },
                        ]}
                        accessibilityRole="link"
                        accessibilityLabel={
                            member.character
                                ? `${member.name}, ${member.character}`
                                : member.name
                        }
                    >
                        {member.profile_path ? (
                            <Image
                                source={{
                                    uri: imageUrl(member.profile_path, 'w185'),
                                }}
                                style={styles.castPhoto}
                                contentFit="cover"
                                transition={150}
                            />
                        ) : (
                            <View
                                style={[
                                    styles.castPhoto,
                                    { backgroundColor: palette.surfaceAlt },
                                ]}
                            />
                        )}
                        <Text
                            style={[
                                typography.caption,
                                styles.castName,
                                { color: palette.text },
                            ]}
                            numberOfLines={2}
                        >
                            {member.name}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
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
                    typography.bodyEmphasis,
                    styles.reviewsHeading,
                    { color: palette.text },
                ]}
            >
                Reviews
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
                // Long-press to Report someone else's review (App Store 1.2).
                // Not for your own review, and only when there's an author to
                // attribute it to.
                const reportable = !isOwn && !!r.userId;
                return (
                    <Pressable
                        key={r.id}
                        onPress={tapAction}
                        onLongPress={
                            reportable
                                ? () =>
                                      promptReport({
                                          type: 'review',
                                          id: r.id,
                                          reportedUserId: r.userId,
                                          title: 'Report review',
                                      })
                                : undefined
                        }
                        // Stay enabled if EITHER a tap or a long-press action
                        // exists — a disabled Pressable fires neither.
                        disabled={!tapAction && !reportable}
                        style={({ pressed }) => [
                            styles.reviewCard,
                            { borderColor: palette.border },
                            pressed && tapAction && { opacity: 0.6 },
                        ]}
                    >
                        <View style={styles.reviewHeaderRow}>
                            <UserLink
                                userId={r.userId}
                                disabled={isOwn || !r.userId}
                                hitSlop={8}
                                accessibilityLabel="View profile"
                            >
                                <Avatar
                                    avatarUrl={r.author?.avatarUrl ?? null}
                                    displayName={
                                        r.author?.displayName ?? 'Former user'
                                    }
                                    seedId={r.userId}
                                    size={32}
                                />
                            </UserLink>
                            <View style={styles.reviewHeaderText}>
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={1}
                                    onPress={
                                        isOwn || !r.userId
                                            ? undefined
                                            : () =>
                                                  goToProfile({
                                                      userId: r.userId,
                                                  })
                                    }
                                >
                                    {isOwn
                                        ? 'You'
                                        : r.author?.displayName ?? 'Former user'}
                                </Text>
                                {/* Rating (if any) + timestamp on one
                                    meta line. No rating → timestamp alone
                                    (avatar + name + text only). */}
                                <View style={styles.reviewMetaRow}>
                                    {r.rating !== null ? (
                                        <Text
                                            style={[
                                                typography.caption,
                                                styles.reviewRating,
                                                { color: palette.accent },
                                            ]}
                                        >
                                            {formatRatingStars(r.rating)}
                                        </Text>
                                    ) : null}
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
                            {/* Visible Report affordance (App Store 1.2) —
                                primary path; the card also long-presses.
                                Someone else's review only (reportable). */}
                            {reportable ? (
                                <Pressable
                                    onPress={() =>
                                        promptReport({
                                            type: 'review',
                                            id: r.id,
                                            reportedUserId: r.userId,
                                            title: 'Report review',
                                        })
                                    }
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    accessibilityLabel="Report review"
                                    style={({ pressed }) => [
                                        styles.reviewReportButton,
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

// "Recommended by" — one card per friend who recommended this title to the
// current user (avatar + name + their note). The note is the point, so it
// gets room (no aggressive truncation). One rec → a single full-width card
// in the friends-watched card family (surfaceElevated / radius.md); several
// → a bleeding horizontal scroll, one card per recommender, matching the
// where-to-watch row. Renders nothing when no one has recommended it.
function RecommendedBySection({
    recs,
    palette,
}: {
    recs: RecAttribution[] | null;
    palette: Palette;
}) {
    if (!recs || recs.length === 0) return null;

    const renderCard = (rec: RecAttribution, fixedWidth: boolean) => (
        <View
            key={rec.sender.userId}
            style={[
                fixedWidth ? styles.recByCardFixed : styles.recByCardFull,
                { backgroundColor: palette.surfaceElevated },
            ]}
        >
            <UserLink
                handle={rec.sender.handle}
                hitSlop={8}
                accessibilityLabel={`View ${rec.sender.displayName}'s profile`}
                style={styles.recByHeader}
            >
                <Avatar
                    avatarUrl={rec.sender.avatarUrl}
                    displayName={rec.sender.displayName}
                    seedId={rec.sender.userId}
                    size={36}
                />
                <Text
                    style={[
                        typography.bodyEmphasis,
                        styles.recByName,
                        { color: palette.text },
                    ]}
                    numberOfLines={1}
                >
                    {rec.sender.displayName}
                </Text>
            </UserLink>
            {rec.note ? (
                <Text
                    style={[
                        typography.body,
                        styles.recByNote,
                        { color: palette.text },
                    ]}
                >
                    “{rec.note}”
                </Text>
            ) : (
                <Text style={[typography.caption, { color: palette.textMuted }]}>
                    Recommended this to you
                </Text>
            )}
        </View>
    );

    return (
        <View style={styles.recBySection}>
            <Text
                style={[
                    typography.bodyEmphasis,
                    { color: palette.text },
                ]}
            >
                Recommended by
            </Text>
            {recs.length === 1 ? (
                renderCard(recs[0], false)
            ) : (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.recByScroll}
                    contentContainerStyle={styles.recByScrollContent}
                >
                    {recs.map((r) => renderCard(r, true))}
                </ScrollView>
            )}
        </View>
    );
}

// Shared caption grammar for the two friend-activity cards ("Watched by" /
// "Watching"). Plain-string version for accessibility labels; the JSX
// FriendNamesCaption below must mirror it exactly:
//   1 → "A"; 2 → "A and B"; 3+ → "A, B and N others" ("1 other" singular).
function friendNamesPlain(names: string[]): string {
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    const others = names.length - 2;
    return `${names[0]}, ${names[1]} and ${others} ${
        others === 1 ? 'other' : 'others'
    }`;
}

// The visual caption: names BOLD, connectors regular weight — the heading
// above the card carries the verb, so the caption doesn't repeat it. Any
// rating average is rendered as a separate muted line by the caller, not
// inline here. Grammar mirrors friendNamesPlain; keep the two in step.
function FriendNamesCaption({
    items,
    palette,
}: {
    items: WatcherSheetItem[];
    palette: Palette;
}) {
    const names = items.map((w) => firstName(w.displayName));
    // Nested spans inherit the parent's colour; bodyEmphasis only flips
    // the weight.
    const bold = (text: string, key: string) => (
        <Text key={key} style={typography.bodyEmphasis}>
            {text}
        </Text>
    );
    const parts: ReactNode[] = [];
    if (names.length === 1) {
        parts.push(bold(names[0], 'first'));
    } else if (names.length === 2) {
        parts.push(bold(names[0], 'first'), ' and ', bold(names[1], 'second'));
    } else {
        const others = names.length - 2;
        parts.push(
            bold(names[0], 'first'),
            ', ',
            bold(names[1], 'second'),
            ` and ${others} ${others === 1 ? 'other' : 'others'}`,
        );
    }
    return (
        <Text
            style={[typography.body, { color: palette.text }]}
            numberOfLines={2}
        >
            {parts}
        </Text>
    );
}

// "Watched by" card — heading + overlapping avatars of friends who've
// watched the title (privacy-filtered to visibility='friends' upstream),
// a bold-names caption with those same friends' rating average as a
// regular-weight tail. Renders NOTHING when no non-private
// friend has watched it (no empty card). Tapping opens the watchers sheet
// (onPress) — the card only shows the first few avatars, so the sheet
// lists everyone.
function FriendActivitySection({
    activity,
    palette,
    onPress,
}: {
    activity: FriendActivity | null;
    palette: Palette;
    onPress: () => void;
}) {
    if (!activity) return null;
    const { watchedFriends, ratingsAverage, ratingsCount } = activity;
    if (watchedFriends.length === 0) return null;

    // Plain names for the accessibility label; the visual caption is
    // FriendNamesCaption (bold names, regular connectors + avg tail).
    const namesText = friendNamesPlain(
        watchedFriends.map((w) => firstName(w.displayName)),
    );

    // Average over the SAME watched set: mean stored 1-10 → stars (÷2),
    // trailing .0 suppressed (4★ not 4.0★). Only when ≥1 of them rated.
    let ratingsLabel = '';
    if (ratingsAverage !== null && ratingsCount > 0) {
        const stars = ratingsAverage / 2;
        ratingsLabel = `${
            Number.isInteger(stars) ? stars : stars.toFixed(1)
        }★ avg`;
    }

    return (
        <View style={styles.friendsSection}>
            {/* Section heading — same voice as Recommended by / Cast /
                Reviews, so the caption below doesn't repeat "watched". */}
            <Text style={[typography.bodyEmphasis, { color: palette.text }]}>
                Watched by
            </Text>
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`Watched by ${namesText}${
                    ratingsLabel !== '' ? `, ${ratingsLabel}` : ''
                }. Tap to see everyone.`}
                style={({ pressed }) => [
                    styles.friendsWatchedCard,
                    { backgroundColor: palette.surfaceElevated },
                    pressed && { opacity: 0.6 },
                ]}
            >
                {/* Avatars on the LEFT, vertically centred against the
                    caption. Big enough (42) to feel present. leadFirst so
                    the lead avatar is the first named friend; borderColor
                    = card fill so chips read cleanly cut-out. */}
                <AvatarStack
                    items={watchedFriends}
                    limit={5}
                    size={42}
                    overlap={16}
                    borderColor={palette.surfaceElevated}
                    leadFirst
                />
                {/* Caption to the RIGHT: bold names, with the rating average
                    on its own muted line below (not crammed inline). flex:1 so
                    it takes the remaining width beside the avatars. */}
                <View style={styles.friendsWatchedText}>
                    <FriendNamesCaption
                        items={watchedFriends}
                        palette={palette}
                    />
                    {ratingsLabel !== '' && (
                        <Text
                            style={[
                                typography.caption,
                                { color: palette.textMuted },
                            ]}
                        >
                            {ratingsLabel}
                        </Text>
                    )}
                </View>
            </Pressable>
        </View>
    );
}

// Friends currently WATCHING this title — the live counterpart to
// FriendActivitySection above. Same card treatment (styles are shared,
// referenced not forked), same AvatarStack params, no ratings line (a
// watching row can't carry a rating). Data-gated: hides itself until at
// least one friend is watching friends-visibly.
function FriendsWatchingSection({
    watching,
    palette,
    onPress,
}: {
    watching: WatcherSheetItem[] | null;
    palette: Palette;
    onPress: () => void;
}) {
    if (!watching || watching.length === 0) return null;

    // Plain names for the accessibility label; the heading carries
    // "Watching", so the caption is just the names (bold via
    // FriendNamesCaption — e.g. "Seanos and Buster", "Seanos, Buster and
    // 4 others").
    const namesText = friendNamesPlain(
        watching.map((w) => firstName(w.displayName)),
    );

    return (
        <View style={styles.friendsSection}>
            <Text style={[typography.bodyEmphasis, { color: palette.text }]}>
                Watching
            </Text>
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`Watching: ${namesText}. Tap to see everyone.`}
                style={({ pressed }) => [
                    styles.friendsWatchedCard,
                    { backgroundColor: palette.surfaceElevated },
                    pressed && { opacity: 0.6 },
                ]}
            >
                <AvatarStack
                    items={watching}
                    limit={5}
                    size={42}
                    overlap={16}
                    borderColor={palette.surfaceElevated}
                    leadFirst
                />
                <View style={styles.friendsWatchedText}>
                    <FriendNamesCaption items={watching} palette={palette} />
                </View>
            </Pressable>
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

// Trailing variant phrases TMDB appends to a provider's name for an
// ad-supported / reseller tier that is really the SAME service (e.g.
// "Netflix Standard with Ads" → "Netflix", "AMC+ Amazon Channel" →
// "AMC+"). Stripped so each real service collapses to one card. Longest
// phrases first so "Standard with Ads" wins over the "with Ads" subset.
const PROVIDER_VARIANT_SUFFIXES: RegExp[] = [
    /\s+standard with ads$/i,
    /\s+premium with ads$/i,
    /\s+basic with ads$/i,
    /\s+with ads$/i,
    /\s+amazon channel$/i,
    /\s+apple tv channel$/i,
    /\s+roku premium channel$/i,
];

// Canonical service name = the provider name with any known variant
// suffix removed. Variants of one service share a root, so keying the
// merge on this collapses them into a single card.
function providerRoot(name: string): string {
    let n = name.trim();
    for (const re of PROVIDER_VARIANT_SUFFIXES) {
        n = n.replace(re, '');
    }
    return n.trim();
}

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

    // De-dupe providers into ONE entry per real service, keyed by the
    // canonical root name (providerRoot) so ad/reseller variants collapse
    // into their parent (e.g. "Netflix" + "Netflix Standard with Ads" →
    // one "Netflix"). Collects which methods the service offers (canonical
    // order stream → rent → buy) into tags, and keeps the lowest-priority
    // member's logo + id as the representative. Sorted by display_priority
    // (TMDB's ranking, lower = more prominent).
    const mergedProviders = (() => {
        const byRoot = new Map<
            string,
            {
                name: string;
                logoPath: string;
                key: number;
                methods: string[];
                priority: number;
            }
        >();
        const collect = (list: TMDBWatchProvider[], method: string) => {
            for (const p of list) {
                const root = providerRoot(p.provider_name);
                const existing = byRoot.get(root);
                if (existing) {
                    if (!existing.methods.includes(method)) {
                        existing.methods.push(method);
                    }
                    // Representative = the lowest-priority (most prominent)
                    // member, so the parent's logo wins over a variant's.
                    if (p.display_priority < existing.priority) {
                        existing.priority = p.display_priority;
                        existing.logoPath = p.logo_path;
                        existing.key = p.provider_id;
                    }
                } else {
                    byRoot.set(root, {
                        name: root,
                        logoPath: p.logo_path,
                        key: p.provider_id,
                        methods: [method],
                        priority: p.display_priority,
                    });
                }
            }
        };
        collect(flatrate, 'stream');
        collect(rent, 'rent');
        collect(buy, 'buy');
        // Order by primary (best) method — stream > rent > buy — so
        // watch-on-subscription options lead, then pay-again ones. A
        // provider's methods array is built in that canonical order, so
        // methods[0] IS its primary method. Within a method group, by
        // display_priority (lower = more prominent; the value already
        // used to pick the winning logo).
        const methodRank = (m: string) =>
            m === 'stream' ? 0 : m === 'rent' ? 1 : 2;
        return [...byRoot.values()].sort((a, b) => {
            const byMethod = methodRank(a.methods[0]) - methodRank(b.methods[0]);
            return byMethod !== 0 ? byMethod : a.priority - b.priority;
        });
    })();

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
                        typography.bodyEmphasis,
                        { color: palette.text },
                    ]}
                >
                    Where to watch
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

            {/* Horizontal scroll row of uniform-width provider cards,
                de-duped to one card per real service (logo + name +
                method tags), mirroring the cast row. Cards are a fixed
                width so a long name wraps to two lines without changing
                card width, and the row's right padding lets the next card
                peek when there are more than fit — signalling scroll. */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.wtwScroll}
                contentContainerStyle={styles.wtwScrollContent}
            >
                {mergedProviders.map((entry) => (
                    <View
                        key={entry.key}
                        style={[
                            styles.wtwCard,
                            { backgroundColor: palette.surfaceElevated },
                        ]}
                        accessible
                        accessibilityLabel={`${entry.name}: ${entry.methods.join(', ')}`}
                    >
                        <View
                            style={[
                                styles.wtwLogoChip,
                                { borderColor: palette.border },
                            ]}
                        >
                            <Image
                                source={{
                                    uri: imageUrl(entry.logoPath, 'original'),
                                }}
                                style={styles.wtwLogo}
                                contentFit="cover"
                                transition={150}
                            />
                        </View>
                        <View style={styles.wtwCardText}>
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.text },
                                ]}
                                numberOfLines={2}
                            >
                                {entry.name}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {entry.methods.join(' · ')}
                            </Text>
                        </View>
                    </View>
                ))}
            </ScrollView>

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
                accessibilityLabel="More details on JustWatch"
            >
                <Text
                    style={[
                        typography.bodyEmphasis,
                        { color: palette.accent },
                    ]}
                >
                    More details on JustWatch
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

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: { alignItems: 'center', justifyContent: 'center' },
    scrollContent: { paddingBottom: spacing.xxl },
    recBySection: {
        // Mirrors the where-to-watch section frame: base inset, lg top gap
        // (matches the friends-watched card's marginTop so the two social
        // cards sit a consistent distance apart), and an inner gap between
        // the heading and the card(s).
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        gap: spacing.md,
    },
    recByScroll: {
        // Full-bleed horizontal row (multi-recommender), next card peeking
        // — same pattern as the where-to-watch / cast rows.
        marginHorizontal: -spacing.base,
    },
    recByScrollContent: {
        paddingHorizontal: spacing.base,
        gap: spacing.md,
    },
    recByCardFull: {
        // Single-recommender card, full content width. Friends-watched card
        // family: surfaceElevated fill (inline) + radius.md, fill-only (no
        // shadow). Note-forward: avatar+name header, then the note beneath.
        borderRadius: radius.md,
        padding: spacing.md,
        gap: spacing.sm,
    },
    recByCardFixed: {
        // Multi-recommender card — fixed width so the note wraps to as many
        // lines as it needs without changing card width; the row scrolls.
        width: 260,
        borderRadius: radius.md,
        padding: spacing.md,
        gap: spacing.sm,
    },
    recByHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    recByName: {
        flex: 1,
    },
    recByNote: {
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
    // Trailer play badge on the hero. Centred horizontally; vertically in
    // the band's upper region (badge centre at ~38% of the band height) so
    // it clears both the gradient fade and the poster overlap below, and
    // reads as "on the image" rather than floating between sections.
    // Size/alpha via PLAY_BADGE_* consts by the other hero constants.
    playBadge: {
        position: 'absolute',
        alignSelf: 'center',
        top: Math.round(BACKDROP_HEIGHT * 0.38) - PLAY_BADGE_SIZE / 2,
        width: PLAY_BADGE_SIZE,
        height: PLAY_BADGE_SIZE,
        borderRadius: PLAY_BADGE_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
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
        // Top-aligned with the poster (flex default — no justifyContent, no
        // paddingTop): the row's top edge IS the poster's top edge, so the
        // title's first line starts level with it and content flows down.
        // One consistent anchor for short and long content alike — the
        // earlier centred layout was designed for title + meta only, and
        // silently degraded once the status line + genre pills joined the
        // column. Legibility at this height is guaranteed by the backdrop
        // gradient reaching full page-bg BY the poster's top edge (see
        // HERO_GRADIENT_END), so the title lands on clean ground, not on
        // the half-faded photo.
    },
    // Status chip row — a distinct row on the plum bg, between the genre
    // tags and Cast (NOT overlaid on the image). Left-aligned and content-
    // sized (chips size to their text — never full-width). Horizontal
    // inset matches the other sections; generous marginTop/Bottom give the
    // row clear breathing room above (genres) and below (Cast).
    statusChipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        // Sits between the synopsis and the cast. Equal breathing room on
        // both sides so it reads as its own interactive row: marginTop lg
        // above, and the following section's own marginTop (lg) carries the
        // gap below, so marginBottom stays 0 to avoid doubling it.
        marginTop: spacing.lg,
        marginBottom: 0,
    },
    // Substantial pill: more internal padding (md/sm) than the Library
    // filter chips so it feels tappable and present. flex:1 makes the
    // three chips share the row as equal-width thirds (full content width,
    // aligned to the Recommend button below), with the label centred.
    // Borderless — the fill alone defines the chip (soft plum wash
    // unselected / solid accent selected, applied inline per state).
    statusChip: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.full,
    },
    statusChipText: {
        // 14/Medium — same label treatment as the Library chips.
        ...typography.caption,
        fontFamily: fontFamily.medium,
        fontWeight: '500',
    },
    tagline: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    crewLine: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    genres: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
        // Lives inside the title column now (no own paddingHorizontal —
        // the column is already inset, and the column's `gap: spacing.xs`
        // gives the tight 4px break under the rating line). A small
        // marginTop adds a hair more separation from the rating line
        // without re-opening the old gap.
        marginTop: spacing.xs,
    },
    genrePill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    castSection: {
        marginTop: spacing.lg,
    },
    castHeading: {
        paddingHorizontal: spacing.base,
        marginBottom: spacing.sm,
    },
    castScrollContent: {
        paddingHorizontal: spacing.base,
        gap: spacing.md,
    },
    castCell: {
        // Fixed width so two-line names don't push following cards
        // out of alignment. Width matches the photo so the name caps
        // visually under the headshot.
        width: 88,
        gap: spacing.xs,
    },
    castPhoto: {
        width: 88,
        height: 88,
        borderRadius: radius.full,
    },
    castName: {
        textAlign: 'center',
    },
    overview: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
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
    wtwScroll: {
        // Break the horizontal row out of the section's base padding so
        // cards scroll edge-to-edge and the next one peeks at the screen
        // edge (the contentContainer re-adds the inset). Mirrors the cast
        // row's full-bleed scroll while header/attribution/CTA keep the
        // wtw padding.
        marginHorizontal: -spacing.base,
    },
    wtwScrollContent: {
        // Matches castScrollContent: base inset on both ends + a gap
        // between cards. The trailing inset is what makes the next card
        // peek rather than sit flush to the edge.
        paddingHorizontal: spacing.base,
        gap: spacing.md,
    },
    wtwCard: {
        // Uniform fixed-width card (logo over name over method tags). The
        // fixed width means a long name wraps to two lines (numberOfLines
        // =2) without changing card width. Cross-axis stretch in the row
        // gives all cards a matching height. The plum surfaceElevated fill
        // (applied inline) is what separates the card from the page — NO
        // shadow: a drop shadow here gets clipped by the horizontal
        // ScrollView viewport (no vertical slack) and renders as a hard
        // line on the bottom/right edges. Matches the friends-watched
        // card, which is also fill-only.
        width: 132,
        gap: spacing.sm,
        borderRadius: radius.md,
        padding: spacing.md,
    },
    wtwCardText: {
        // Fill the space below the logo (cards are uniform height via
        // cross-axis stretch in the row) and split name/tag to opposite
        // ends: the name flows from the top, the method tag pins to the
        // bottom. Because every card's text block bottoms out at the same
        // height, the tags line up across the row regardless of whether a
        // name is one or two lines.
        flex: 1,
        justifyContent: 'space-between',
        // Floor between a 2-line name and the tag when the text block has
        // no slack (the tallest card), so they never touch.
        gap: spacing.xs,
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
        // Required attribution caption. Kept visible and directly below
        // the provider cards it credits, per TMDB's terms for the watch
        // providers endpoint. Sits in the section's standard gap under the
        // cards (no extra top margin) so it reads as their source line;
        // the CTA below carries its own marginTop to separate from it. Do
        // NOT move into a tooltip or "info" sheet.
    },
    wtwCta: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
        // Extra separation from the attribution caption above, so that
        // caption groups visually with the provider cards, not the CTA.
        marginTop: spacing.sm,
    },
    // "Friends watched this" card — a distinct plum panel, set in from the
    // page edges. Row: avatars on the left, text block on the right,
    // vertically centred against each other. Even `padding` inside the
    // card; `gap` separates the avatars from the text.
    // Shared frame for the two friend-activity sections (Watched by /
    // Watching): mirrors recBySection — base inset, lg top gap, md gap
    // between the heading and the card — so Recommended by / Watched by /
    // Watching stack with one rhythm.
    friendsSection: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        gap: spacing.md,
    },
    // The card itself carries no outer margins — friendsSection above owns
    // inset + top gap for both cards.
    friendsWatchedCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.md,
        borderRadius: radius.md,
    },
    friendsWatchedText: {
        // Takes the width beside the avatars; caption (≤2 lines) stacked
        // over the avg with a small consistent gap.
        flex: 1,
        gap: spacing.xs,
    },
    // "Your relationship" line — last child of the title column, under the
    // genre chips: the star-glyph rating row (watched) or a quiet status
    // caption (watchlist/watching). The privacy lock that used to share
    // this row moved to the visibilityRow above Recommend.
    statusLine: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 18,
    },
    // Tappable rating (watched only): star glyphs + pencil edit affordance.
    statusEdit: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        flexShrink: 1,
    },
    // Glyph stars at display size — deliberately larger than the caption
    // metadata around them so YOUR verdict is the loudest line in the title
    // column. Line-height pinned so the tall glyphs don't stretch the row.
    ratingStars: {
        fontSize: 22,
        lineHeight: 26,
        letterSpacing: 1,
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
    reviewReportButton: {
        // Trailing "⋯" on the review header — reviewHeaderText's flex:1
        // pushes it to the card's right edge. Quiet (textMuted).
        padding: spacing.xs,
    },
    reviewMetaRow: {
        // Rating (accent) + timestamp (muted) on one line under the name.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    reviewRating: {
        fontFamily: fontFamily.medium,
        fontWeight: '500',
    },
    reviewSpoilerCover: {
        fontStyle: 'italic',
    },
    // Sharing group card: visibility toggle + Recommend + Chat as one
    // unit. Same treatment as the recBy/friends-watched card family
    // (surfaceElevated inline, radius.md, fill-only). The card owns the
    // horizontal inset and the md rhythm between its children — the
    // children carry no margins of their own.
    sharingCard: {
        marginHorizontal: spacing.base,
        marginTop: spacing.lg,
        borderRadius: radius.md,
        padding: spacing.md,
        gap: spacing.md,
    },
    // "Visible to friends" label + switch, full-width row at the card's
    // top. Plain row (no fill/border) — a setting, not a button; the
    // Toggle itself is the visual state.
    visibilityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: spacing.xs,
    },
    recommendButton: {
        // Filled accent — the border that lived here when the button
        // was outlined is gone; the background colour now defines the
        // edge. Full card width; the sharingCard supplies inset + rhythm.
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
    },
    chatButton: {
        // Ghost secondary beneath Recommend: accent icon + label, no
        // fill/border — quiet but active (see the JSX comment). The card's
        // md gap keeps it its own distinct action rather than crowding
        // the filled Recommend; the shorter padding (sm vs Recommend's 14)
        // keeps it subordinate.
        flexDirection: 'row',
        gap: spacing.xs,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.sm,
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
