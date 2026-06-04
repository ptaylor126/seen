import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Mail } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { RatingSheet } from '@/components/rating-sheet';
import {
    SEARCH_OVERLAY_TOP_OFFSET,
    SearchBarInput,
    SearchBarOverlay,
    useSearchBar,
} from '@/components/search-bar';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { applyWatchedRating, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface RecForYou {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    note: string | null;
    sender: {
        userId: string;
        handle: string;
        displayName: string;
        avatarUrl: string | null;
    };
}

interface FriendCard {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    // All friends currently watching this show, ordered most-recent
    // activity first. Tile renders the first 5 as a stacked-avatar row;
    // any extra are summarised in a +N chip.
    watchers: {
        userId: string;
        displayName: string;
        avatarUrl: string | null;
    }[];
    totalWatchers: number;
}

interface WatchingItem {
    tmdbId: number;
    mediaType: MediaType;
    // Existing items.rating, if any — passed through to the
    // RatingSheet so re-rates pre-fill the previous pick.
    rating: number | null;
    title: string;
    posterPath: string | null;
    year: string;
    addedAt: string;
}

interface HomeData {
    recsForYou: RecForYou[];
    friendCards: FriendCard[];
    currentlyWatching: WatchingItem[];
    hasLibraryItems: boolean;
    hasFriends: boolean;
}

// Recs for you — HERO cards. One card mostly visible at a time with
// the next card peeking on the right edge to invite swipe.
const HERO_SCREEN_W = Dimensions.get('window').width;
const REC_CARD_W = Math.round(HERO_SCREEN_W * 0.85);
const REC_CARD_H = 200;
const REC_POSTER_W = 120;
const REC_POSTER_H = 180;
const REC_AVATAR_SIZE = 40;

// Friends are watching — horizontal scrolling row of 2:3 posters, no
// labels. Pure visual scan with the half-poster peek at the right edge
// signalling there's more to swipe.
//
// Sizing math: visible budget = HERO_SCREEN_W - left inset. We want
// 3.5 posters + 3 inter-poster gaps to fit in that budget. Solving for
// posterW:
//   3.5 * posterW + 3 * gap = HERO_SCREEN_W - inset
//   posterW = (HERO_SCREEN_W - inset - 3 * gap) / 3.5
// Math.floor keeps us strictly within the visible width (any pixel of
// drift would push the 4th poster's edge off-screen).
const FRIENDS_ROW_GAP = spacing.base;
const FRIENDS_ROW_INSET = spacing.base;
const FRIENDS_ROW_POSTER_W = Math.floor(
    (HERO_SCREEN_W - FRIENDS_ROW_INSET - 3 * FRIENDS_ROW_GAP) / 3.5,
);
const FRIENDS_ROW_POSTER_H = Math.floor(FRIENDS_ROW_POSTER_W * 1.5);
const FRIENDS_GRID_LIMIT = 8;

// Currently watching — compact list row. Smaller poster than the
// previous layout (40 × 60 instead of 56 × 84), denser vertical
// padding, single-line title + inline relative-time secondary.
const WATCHING_POSTER_W = 40;
const WATCHING_POSTER_H = 60;

// Single-rec hero — when only one rec exists, fill the available width
// minus the section's horizontal padding so the card doesn't read as
// "tiny floating thing waiting for siblings."
const REC_CARD_SOLO_W = HERO_SCREEN_W - spacing.base * 2;

// Friends row stacked-avatar overlay — small social-proof row on each
// poster's bottom-right corner showing every friend currently watching
// this title (cap-then-overflow). 20 px tuned to the row's ~93 pt
// posters so the chip reads proportionally to the cell (matches the
// ~26% chip-to-cell ratio the previous 18 px gave on the old 80 pt
// squares). At 5 chips + "+N" with 50% overlap, the stack is ~84 pt
// wide and fits the cell comfortably with room to spare.
const FRIENDS_GRID_AVATAR_SIZE = 20;
const FRIENDS_GRID_MAX_AVATARS = 5;
// Negative marginLeft applied to every chip after the first so each
// overlaps its left neighbour. Scales with the chip outer (avatar +
// 4 pt of border on each side = 24 pt outer, half = 12 pt overlap).
const FRIENDS_GRID_STACK_OVERLAP = 12;

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
}

// "Added 3 days ago"-style relative formatter. Inline (rather than
// pulling in date-fns) because the Home dashboard is currently the
// only consumer; reach for a library if a second screen needs the
// same shape.
function formatAdded(iso: string): string {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < 60) return 'Added just now';
    if (seconds < 90) return 'Added a minute ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Added ${minutes} minutes ago`;
    if (minutes < 90) return 'Added an hour ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Added ${hours} hours ago`;
    if (hours < 36) return 'Added a day ago';
    const days = Math.floor(hours / 24);
    if (days < 30) return `Added ${days} days ago`;
    const months = Math.floor(days / 30);
    if (months < 12) {
        return months === 1 ? 'Added a month ago' : `Added ${months} months ago`;
    }
    const years = Math.floor(days / 365);
    return years === 1 ? 'Added a year ago' : `Added ${years} years ago`;
}

// Fetch everything for the Home screen. Three waves: source queries,
// dependent profile/items lookups, then TMDB metadata. The TMDB layer
// is N+1 across all sections — acceptable at MVP scale since expo-image
// caches posters by URL; only the JSON metadata is the real cost.
async function fetchHomeData(userId: string): Promise<HomeData> {
    // ---- Wave 1: source queries (parallel)
    const [
        recsResult,
        friendshipsResult,
        watchingResult,
        itemsCountResult,
    ] = await Promise.all([
        supabase
            .from('recommendations')
            .select('id, from_user_id, tmdb_id, media_type, sent_at, status, note')
            .eq('to_user_id', userId)
            .in('status', ['pending', 'accepted'])
            .order('sent_at', { ascending: false })
            .limit(10),
        supabase
            .from('friendships')
            .select('user_a_id, user_b_id')
            .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`),
        supabase
            .from('items')
            .select('tmdb_id, media_type, rating, updated_at, created_at')
            .eq('user_id', userId)
            .eq('status', 'watching')
            .order('updated_at', { ascending: false })
            .limit(20),
        supabase
            .from('items')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
    ]);

    if (recsResult.error) throw recsResult.error;
    if (friendshipsResult.error) throw friendshipsResult.error;
    if (watchingResult.error) throw watchingResult.error;
    if (itemsCountResult.error) throw itemsCountResult.error;

    const recs = recsResult.data ?? [];
    const watchingRows = watchingResult.data ?? [];
    const friendIds = (friendshipsResult.data ?? []).map((f) =>
        f.user_a_id === userId ? f.user_b_id : f.user_a_id,
    );

    // ---- Wave 2: friend items + sender profiles (parallel)
    const senderIds = new Set<string>();
    for (const r of recs) {
        if (r.from_user_id) senderIds.add(r.from_user_id);
    }

    const [friendItemsResult, senderProfilesResult] = await Promise.all([
        friendIds.length > 0
            ? supabase
                  .from('items')
                  .select(
                      'user_id, tmdb_id, media_type, status, updated_at, created_at, rating',
                  )
                  .in('user_id', friendIds)
                  // Section is "Friends are watching" — only the watching
                  // status drives the social proof. Watched-by-friends
                  // belongs elsewhere if we ever surface it.
                  .eq('status', 'watching')
                  .order('updated_at', { ascending: false })
                  // Bumped from 40 → 200 so popular shows don't get
                  // their watcher count clipped: with grouping we need
                  // enough rows in the window to surface every friend
                  // who's watching X, not just the most recent few.
                  .limit(200)
            : Promise.resolve({ data: [], error: null }),
        senderIds.size > 0
            ? supabase
                  .from('profiles')
                  .select('id, handle, display_name, avatar_url')
                  .in('id', Array.from(senderIds))
            : Promise.resolve({ data: [], error: null }),
    ]);

    if (friendItemsResult.error) throw friendItemsResult.error;
    if (senderProfilesResult.error) throw senderProfilesResult.error;

    // Group friend items by (media_type, tmdb_id) — one card per show,
    // carrying the list of friends watching it. Items arrive ordered
    // updated_at DESC, so the first occurrence per show pins
    // `mostRecentAt` to the freshest activity; subsequent watchers are
    // appended (deduped by user_id in case a friend somehow has two
    // watching rows for the same show).
    interface FriendItemRow {
        user_id: string;
        tmdb_id: number;
        media_type: string;
        status: string;
        updated_at: string;
        created_at: string;
        rating: number | null;
    }
    interface FriendShowGroup {
        tmdbId: number;
        mediaType: MediaType;
        mostRecentAt: string;
        watcherIds: string[];
    }
    const friendItems = (friendItemsResult.data ?? []) as FriendItemRow[];
    const groupsByKey = new Map<string, FriendShowGroup>();
    for (const item of friendItems) {
        const key = `${item.media_type}:${item.tmdb_id}`;
        let group = groupsByKey.get(key);
        if (!group) {
            group = {
                tmdbId: item.tmdb_id,
                mediaType: item.media_type as MediaType,
                mostRecentAt: item.updated_at,
                watcherIds: [],
            };
            groupsByKey.set(key, group);
        }
        if (!group.watcherIds.includes(item.user_id)) {
            group.watcherIds.push(item.user_id);
        }
    }
    // Primary sort: watcher count DESC (social proof). Tie: most recent
    // activity DESC — ISO timestamps sort lexicographically.
    const friendShowGroups = Array.from(groupsByKey.values()).sort(
        (a, b) =>
            b.watcherIds.length - a.watcherIds.length ||
            b.mostRecentAt.localeCompare(a.mostRecentAt),
    );

    // Profiles batched for ALL distinct watchers across all groups —
    // each group needs every watcher's avatar, not just the first.
    const friendItemOwnerIds = Array.from(
        new Set(friendItems.map((i) => i.user_id)),
    );

    // ---- Wave 3: friend owner display names + TMDB metadata (parallel)
    //
    // TMDB requests are wrapped in Promise.allSettled so a single failed
    // lookup doesn't take down the whole Home dashboard — the section
    // just won't render that card.
    const friendProfilesPromise =
        friendItemOwnerIds.length > 0
            ? supabase
                  .from('profiles')
                  .select('id, display_name, avatar_url')
                  .in('id', friendItemOwnerIds)
            : Promise.resolve({ data: [], error: null });

    const recTitlePromises = recs.map((r) =>
        r.media_type === 'movie'
            ? getMovie(r.tmdb_id).then((m) => ({
                  title: m.title,
                  posterPath: m.poster_path,
              }))
            : getTV(r.tmdb_id).then((t) => ({
                  title: t.name,
                  posterPath: t.poster_path,
              })),
    );

    const friendTitlePromises = friendShowGroups.map((g) =>
        g.mediaType === 'movie'
            ? getMovie(g.tmdbId).then((m) => ({
                  title: m.title,
                  posterPath: m.poster_path,
              }))
            : getTV(g.tmdbId).then((t) => ({
                  title: t.name,
                  posterPath: t.poster_path,
              })),
    );

    const watchingTitlePromises = watchingRows.map((w) =>
        w.media_type === 'movie'
            ? getMovie(w.tmdb_id).then((m) => ({
                  title: m.title,
                  posterPath: m.poster_path,
                  year: m.release_date ? m.release_date.slice(0, 4) : '',
              }))
            : getTV(w.tmdb_id).then((t) => ({
                  title: t.name,
                  posterPath: t.poster_path,
                  year: t.first_air_date ? t.first_air_date.slice(0, 4) : '',
              })),
    );

    const [
        friendProfilesResult,
        recTitleResults,
        friendTitleResults,
        watchingTitleResults,
    ] = await Promise.all([
        friendProfilesPromise,
        Promise.allSettled(recTitlePromises),
        Promise.allSettled(friendTitlePromises),
        Promise.allSettled(watchingTitlePromises),
    ]);

    if (friendProfilesResult.error) throw friendProfilesResult.error;

    const friendProfileById = new Map<
        string,
        { displayName: string; avatarUrl: string | null }
    >(
        friendProfilesResult.data?.map((p) => [
            p.id,
            { displayName: p.display_name, avatarUrl: p.avatar_url },
        ]) ?? [],
    );
    const senderProfileById = new Map(
        senderProfilesResult.data?.map((p) => [p.id, p]) ?? [],
    );

    // ---- Build sections

    const recsForYou: RecForYou[] = [];
    recs.forEach((r, i) => {
        const titleResult = recTitleResults[i];
        if (titleResult.status !== 'fulfilled') return;
        const senderProfile = r.from_user_id
            ? senderProfileById.get(r.from_user_id)
            : null;
        recsForYou.push({
            id: r.id,
            tmdbId: r.tmdb_id,
            mediaType: r.media_type as MediaType,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            note: typeof r.note === 'string' && r.note.length > 0 ? r.note : null,
            sender: {
                // Fallback to the rec id when the sender's profile is
                // gone (deleted account) — keeps the avatar colour
                // deterministic per orphaned rec instead of all
                // collapsing onto the same hash of 'unknown'.
                userId: r.from_user_id ?? r.id,
                handle: senderProfile?.handle ?? 'unknown',
                displayName: senderProfile?.display_name ?? 'Former user',
                avatarUrl: senderProfile?.avatar_url ?? null,
            },
        });
    });

    const friendCards: FriendCard[] = [];
    friendShowGroups.forEach((group, i) => {
        const titleResult = friendTitleResults[i];
        if (titleResult.status !== 'fulfilled') return;
        const watchers = group.watcherIds.map((id) => {
            const profile = friendProfileById.get(id);
            return {
                userId: id,
                displayName: profile?.displayName ?? 'A friend',
                avatarUrl: profile?.avatarUrl ?? null,
            };
        });
        friendCards.push({
            tmdbId: group.tmdbId,
            mediaType: group.mediaType,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            watchers,
            totalWatchers: watchers.length,
        });
    });

    const currentlyWatching: WatchingItem[] = [];
    watchingRows.forEach((w, i) => {
        const titleResult = watchingTitleResults[i];
        if (titleResult.status !== 'fulfilled') return;
        currentlyWatching.push({
            tmdbId: w.tmdb_id,
            mediaType: w.media_type as MediaType,
            rating: typeof w.rating === 'number' ? w.rating : null,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            year: titleResult.value.year,
            addedAt: typeof w.created_at === 'string' ? w.created_at : '',
        });
    });

    return {
        recsForYou,
        friendCards,
        currentlyWatching,
        hasLibraryItems: (itemsCountResult.count ?? 0) > 0,
        hasFriends: friendIds.length > 0,
    };
}

export default function HomeScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { count: unreadCount } = useUnreadCount();

    const [data, setData] = useState<HomeData | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Rating sheet target: when present, the sheet is shown for this
    // (mediaType, tmdbId) pair. handleMarkWatched sets it after the
    // 'watching' → 'watched' transition succeeds; submission/dismiss
    // clears it. `rating` carries the existing items.rating so the
    // sheet can pre-fill (rare for watching items, but possible if
    // the user moved a watched item back to watching).
    const [ratingTarget, setRatingTarget] = useState<{
        tmdbId: number;
        mediaType: MediaType;
        rating: number | null;
    } | null>(null);
    const [ratingBusy, setRatingBusy] = useState(false);

    const search = useSearchBar();

    // CTA from the Currently watching empty state: refocus the home
    // input so the user lands directly in the search experience.
    // Fallback to the /library/add modal route on the unlikely event
    // the input ref is not yet attached.
    function handleSearchFromEmpty() {
        if (search.inputRef.current) {
            search.inputRef.current.focus();
        } else {
            router.push({ pathname: '/library/add' });
        }
    }

    const load = useCallback(async () => {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (!userId) throw new Error('Not authenticated');
        return fetchHomeData(userId);
    }, []);

    useFocusEffect(
        useCallback(() => {
            let active = true;
            (async () => {
                try {
                    const result = await load();
                    if (!active) return;
                    setData(result);
                    setError(null);
                } catch (err) {
                    if (!active) return;
                    console.error('home fetch failed:', err);
                    setError(err instanceof Error ? err.message : 'Failed to load');
                } finally {
                    if (active) setLoading(false);
                }
            })();
            return () => {
                active = false;
            };
        }, [load]),
    );

    async function handleRefresh() {
        setRefreshing(true);
        try {
            const result = await load();
            setData(result);
            setError(null);
        } catch (err) {
            console.error('home refresh failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setRefreshing(false);
        }
    }

    // Object form (rather than a template-literal string) so the typed
    // router accepts the call — string interpolation widens to `string`
    // and doesn't pattern-match the `/title/${...}/${...}` Href shape.
    function navigateToTitle(mediaType: MediaType, tmdbId: number, fromRec?: string) {
        router.push({
            pathname: '/title/[mediaType]/[tmdbId]',
            params: fromRec
                ? { mediaType, tmdbId: String(tmdbId), fromRec }
                : { mediaType, tmdbId: String(tmdbId) },
        });
    }

    // Transition a Currently Watching row to status='watched', then open
    // the rating sheet. The rating itself (and any matching open rec's
    // transition into watched) is applied by handleRatingSubmit after
    // the user picks stars or skips.
    async function handleMarkWatched(item: WatchingItem) {
        if (ratingBusy || ratingTarget) return;
        setRatingBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error: updateError } = await supabase
                .from('items')
                .update({
                    status: 'watched',
                    watched_at: new Date().toISOString(),
                })
                .eq('user_id', userId)
                .eq('tmdb_id', item.tmdbId)
                .eq('media_type', item.mediaType);
            if (updateError) throw updateError;

            setRatingTarget({
                tmdbId: item.tmdbId,
                mediaType: item.mediaType,
                rating: item.rating,
            });
        } catch (err) {
            console.error('mark watched failed:', err);
            surfaceUpdateError(err);
        } finally {
            setRatingBusy(false);
        }
    }

    async function handleRatingSubmit(rating: number | null) {
        const target = ratingTarget;
        if (!target) return;
        // Close the sheet immediately so the UI doesn't trap the user
        // behind a spinner if the network is slow.
        setRatingTarget(null);
        setRatingBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            await applyWatchedRating({
                userId,
                tmdbId: target.tmdbId,
                mediaType: target.mediaType,
                rating,
            });

            // Refresh so the now-watched item drops out of Currently
            // watching and the rec (if any) leaves Recs for you.
            const refreshed = await load();
            setData(refreshed);
        } catch (err) {
            console.error('rating apply failed:', err);
            surfaceUpdateError(err);
        } finally {
            setRatingBusy(false);
        }
    }

    function surfaceUpdateError(err: unknown) {
        if (err && typeof err === 'object' && 'message' in err) {
            const supaErr = err as {
                message: string;
                hint?: string;
            };
            Alert.alert(
                'Update failed',
                `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
            );
        } else {
            Alert.alert('Update failed', String(err));
        }
    }

    // ---- Renderers

    function renderHeader() {
        return (
            <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
                <View style={styles.header}>
                    <Image
                        // Black variant on the home header — coral is
                        // reserved for the onboarding welcome
                        // marquee.
                        source={require('../../../assets/logo-black.png')}
                        style={styles.headerLogo}
                        contentFit="contain"
                        accessibilityLabel="Seen"
                    />
                    <Pressable
                        onPress={() => router.push({ pathname: '/inbox' })}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <View>
                            <Mail
                                color={palette.text}
                                size={24}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                            {unreadCount > 0 && (
                                <View
                                    style={[
                                        styles.badge,
                                        { backgroundColor: palette.accent },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.badgeText,
                                            { color: palette.textInverse },
                                        ]}
                                    >
                                        {unreadCount > 9 ? '9+' : String(unreadCount)}
                                    </Text>
                                </View>
                            )}
                        </View>
                    </Pressable>
                </View>
            </SafeAreaView>
        );
    }

    // Shared between the single-card and multi-card render paths so a
    // change to the card layout doesn't have to land in two places.
    // `cardWidth` is overridden inline because the solo and carousel
    // widths differ; everything else comes from styles.recHeroCard.
    function renderRecHeroCard(rec: RecForYou, cardWidth: number) {
        return (
            <Pressable
                key={rec.id}
                onPress={() =>
                    navigateToTitle(rec.mediaType, rec.tmdbId, rec.id)
                }
                style={({ pressed }) => [
                    styles.recHeroCard,
                    {
                        width: cardWidth,
                        backgroundColor: palette.surfaceAlt,
                        borderColor: palette.border,
                    },
                    pressed && { opacity: 0.85 },
                ]}
            >
                {rec.posterPath ? (
                    <Image
                        source={{ uri: imageUrl(rec.posterPath, 'w342') }}
                        style={styles.recHeroPoster}
                        contentFit="cover"
                        transition={150}
                    />
                ) : (
                    <View
                        style={[
                            styles.recHeroPoster,
                            { backgroundColor: palette.surface },
                        ]}
                    />
                )}
                <View style={styles.recHeroContent}>
                    <View style={styles.recHeroSenderRow}>
                        <Avatar
                            avatarUrl={rec.sender.avatarUrl}
                            displayName={rec.sender.displayName}
                            seedId={rec.sender.userId}
                            size={REC_AVATAR_SIZE}
                        />
                        <View style={styles.recHeroSenderText}>
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.accent },
                                ]}
                                numberOfLines={1}
                            >
                                {firstName(rec.sender.displayName)}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                recommends
                            </Text>
                        </View>
                    </View>
                    <Text
                        style={[
                            typography.heading,
                            { color: palette.text },
                        ]}
                        numberOfLines={2}
                    >
                        {rec.title}
                    </Text>
                    {rec.note ? (
                        <Text
                            style={[
                                styles.recNote,
                                { color: palette.textMuted },
                            ]}
                            numberOfLines={2}
                        >
                            “{rec.note}”
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    function renderRecsForYou(data: HomeData) {
        return (
            <View style={styles.section}>
                <Text
                    style={[
                        typography.bodyEmphasis,
                        styles.sectionHeader,
                        { color: palette.text },
                    ]}
                >
                    Recs for you
                </Text>
                {data.recsForYou.length > 0 ? (
                    // Single rec → render at near-full width without
                    // the horizontal scroller, since there's nothing
                    // to swipe to. Multi-rec → keep the 85%-width
                    // cards in a snap-scroll so the next card peeks
                    // and invites the swipe.
                    data.recsForYou.length === 1 ? (
                        <View style={styles.recSoloRow}>
                            {renderRecHeroCard(data.recsForYou[0], REC_CARD_SOLO_W)}
                        </View>
                    ) : (
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.recCardsRow}
                            snapToInterval={REC_CARD_W + spacing.md}
                            decelerationRate="fast"
                        >
                            {data.recsForYou.map((rec) =>
                                renderRecHeroCard(rec, REC_CARD_W),
                            )}
                        </ScrollView>
                    )
                ) : (
                    <View style={styles.inlineEmpty}>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            When friends recommend something, it shows up here.{' '}
                            <Text
                                style={[typography.body, { color: palette.accent }]}
                                onPress={() =>
                                    router.push({ pathname: '/friends/add' })
                                }
                                suppressHighlighting
                            >
                                Add friends
                            </Text>
                        </Text>
                    </View>
                )}
            </View>
        );
    }

    function renderFriendsWatching(data: HomeData) {
        const gridItems = data.friendCards.slice(0, FRIENDS_GRID_LIMIT);
        return (
            <View style={styles.section}>
                <Text
                    style={[
                        typography.bodyEmphasis,
                        styles.sectionHeader,
                        { color: palette.text },
                    ]}
                >
                    Friends are watching
                </Text>
                {gridItems.length > 0 ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.friendsRowContent}
                    >
                        {gridItems.map((card) => {
                            const shown = card.watchers.slice(
                                0,
                                FRIENDS_GRID_MAX_AVATARS,
                            );
                            const extra =
                                card.totalWatchers - shown.length;
                            return (
                                <Pressable
                                    key={`${card.mediaType}-${card.tmdbId}`}
                                    onPress={() =>
                                        navigateToTitle(card.mediaType, card.tmdbId)
                                    }
                                    style={({ pressed }) => [
                                        styles.friendsGridCell,
                                        pressed && { opacity: 0.6 },
                                    ]}
                                    accessibilityLabel={`${card.title}, ${card.totalWatchers} friend${
                                        card.totalWatchers === 1 ? '' : 's'
                                    } watching`}
                                >
                                    {card.posterPath ? (
                                        <Image
                                            source={{
                                                uri: imageUrl(card.posterPath, 'w185'),
                                            }}
                                            style={styles.friendsGridPoster}
                                            contentFit="cover"
                                            transition={150}
                                        />
                                    ) : (
                                        <View
                                            style={[
                                                styles.friendsGridPoster,
                                                { backgroundColor: palette.surfaceAlt },
                                            ]}
                                        />
                                    )}
                                    {/* Stacked-avatar social proof. Render
                                        order is left-to-right (front-of-
                                        stack = last drawn = rightmost):
                                        [+N (if any), …shown.reverse()] so
                                        the most-recent watcher (first
                                        item in `shown`) lands rightmost
                                        and on top, with older watchers
                                        and the +N pill tucked behind to
                                        the left. Each non-first chip
                                        overlaps its predecessor via a
                                        negative marginLeft. */}
                                    <View style={styles.friendsGridStack}>
                                        {extra > 0 ? (
                                            <View
                                                style={[
                                                    styles.friendsGridStackChip,
                                                    styles.friendsGridStackOverflow,
                                                    {
                                                        backgroundColor: palette.accent,
                                                        borderColor: palette.bg,
                                                    },
                                                ]}
                                            >
                                                <Text
                                                    style={[
                                                        styles.friendsGridOverflowText,
                                                        { color: palette.textInverse },
                                                    ]}
                                                >
                                                    +{extra}
                                                </Text>
                                            </View>
                                        ) : null}
                                        {shown
                                            .slice()
                                            .reverse()
                                            .map((w, idx) => {
                                                const isLeftmost =
                                                    idx === 0 && extra === 0;
                                                return (
                                                    <View
                                                        key={w.userId}
                                                        style={[
                                                            styles.friendsGridStackChip,
                                                            !isLeftmost && {
                                                                marginLeft:
                                                                    -FRIENDS_GRID_STACK_OVERLAP,
                                                            },
                                                            { borderColor: palette.bg },
                                                        ]}
                                                    >
                                                        <Avatar
                                                            avatarUrl={w.avatarUrl}
                                                            displayName={w.displayName}
                                                            seedId={w.userId}
                                                            size={FRIENDS_GRID_AVATAR_SIZE}
                                                        />
                                                    </View>
                                                );
                                            })}
                                    </View>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                ) : (
                    <View style={styles.inlineEmpty}>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            See what your friends are watching.{'\n'}
                            <Text
                                style={[typography.body, { color: palette.accent }]}
                                onPress={() =>
                                    router.push({ pathname: '/friends/add' })
                                }
                                suppressHighlighting
                            >
                                Add friends
                            </Text>
                        </Text>
                    </View>
                )}
            </View>
        );
    }

    function renderCurrentlyWatching(data: HomeData) {
        return (
            <View style={styles.section}>
                <Text
                    style={[
                        typography.bodyEmphasis,
                        styles.sectionHeader,
                        { color: palette.text },
                    ]}
                >
                    Currently watching
                </Text>
                {data.currentlyWatching.length > 0 ? (
                    <View style={styles.watchingList}>
                        {data.currentlyWatching.map((item, i) => {
                            const addedLine = item.addedAt
                                ? formatAdded(item.addedAt)
                                : '';
                            const disabled = ratingBusy || !!ratingTarget;
                            return (
                                <View key={`${item.mediaType}-${item.tmdbId}`}>
                                    {i > 0 && (
                                        <View
                                            style={[
                                                styles.watchingSeparator,
                                                { backgroundColor: palette.border },
                                            ]}
                                        />
                                    )}
                                    <View style={styles.watchingRow}>
                                        <Pressable
                                            onPress={() =>
                                                navigateToTitle(
                                                    item.mediaType,
                                                    item.tmdbId,
                                                )
                                            }
                                            style={({ pressed }) => [
                                                styles.watchingRowBody,
                                                pressed && { opacity: 0.6 },
                                            ]}
                                        >
                                            {item.posterPath ? (
                                                <Image
                                                    source={{
                                                        uri: imageUrl(
                                                            item.posterPath,
                                                            'w185',
                                                        ),
                                                    }}
                                                    style={styles.watchingPoster}
                                                    contentFit="cover"
                                                    transition={150}
                                                />
                                            ) : (
                                                <View
                                                    style={[
                                                        styles.watchingPoster,
                                                        {
                                                            backgroundColor:
                                                                palette.surfaceAlt,
                                                        },
                                                    ]}
                                                />
                                            )}
                                            {/* Title above, time below.
                                                Stacked rather than
                                                inline because long
                                                titles + the "Added X
                                                ago" tag don't fit on
                                                one line in the row's
                                                available width and the
                                                title was getting
                                                truncated to 4-5 chars. */}
                                            <View style={styles.watchingText}>
                                                <Text
                                                    style={[
                                                        typography.bodyEmphasis,
                                                        { color: palette.text },
                                                    ]}
                                                    numberOfLines={1}
                                                >
                                                    {item.title}
                                                </Text>
                                                {addedLine ? (
                                                    <Text
                                                        style={[
                                                            typography.caption,
                                                            {
                                                                color: palette.textMuted,
                                                            },
                                                        ]}
                                                        numberOfLines={1}
                                                    >
                                                        {addedLine}
                                                    </Text>
                                                ) : null}
                                            </View>
                                        </Pressable>
                                        <Pressable
                                            onPress={() => handleMarkWatched(item)}
                                            disabled={disabled}
                                            style={({ pressed }) => [
                                                styles.markWatchedPill,
                                                {
                                                    backgroundColor: palette.accent,
                                                    opacity:
                                                        pressed || disabled
                                                            ? 0.6
                                                            : 1,
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
                                                Mark watched
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })}
                    </View>
                ) : (
                    <View style={styles.inlineEmpty}>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            Things you&apos;re watching live here. Add something to
                            start tracking.{' '}
                            <Text
                                style={[typography.body, { color: palette.accent }]}
                                onPress={handleSearchFromEmpty}
                                suppressHighlighting
                            >
                                Search to add
                            </Text>
                        </Text>
                    </View>
                )}
            </View>
        );
    }

    function renderGlobalEmpty() {
        return (
            <View style={styles.globalEmpty}>
                <Text
                    style={[
                        typography.display,
                        styles.globalEmptyHeading,
                        { color: palette.text },
                    ]}
                >
                    Welcome to Seen
                </Text>
                <Text
                    style={[
                        typography.body,
                        styles.globalEmptyBody,
                        { color: palette.textMuted },
                    ]}
                >
                    Track what you&apos;ve watched, share recs with friends, and
                    discover what&apos;s good through people you trust.
                </Text>
                <View style={styles.globalEmptyActions}>
                    <Pressable
                        onPress={() => router.push({ pathname: '/library/add' })}
                        style={({ pressed }) => [
                            styles.primaryButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Search for something to track
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => router.push({ pathname: '/friends' })}
                        style={({ pressed }) => [
                            styles.secondaryButton,
                            {
                                borderColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[typography.bodyEmphasis, { color: palette.accent }]}
                        >
                            Add a friend
                        </Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    // ---- Top-level body

    let body: React.ReactNode;
    if (loading && !data) {
        body = (
            <View style={styles.fillCenter}>
                <ActivityIndicator color={palette.accent} />
            </View>
        );
    } else if (error && !data) {
        body = (
            <View style={styles.fillCenter}>
                <Text
                    style={[typography.body, { color: palette.error }]}
                    numberOfLines={3}
                >
                    {error}
                </Text>
            </View>
        );
    } else if (data) {
        const globalEmpty =
            !data.hasLibraryItems &&
            !data.hasFriends &&
            data.recsForYou.length === 0;
        body = (
            <ScrollView
                contentContainerStyle={styles.scrollContent}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={palette.accent}
                    />
                }
            >
                {globalEmpty ? (
                    renderGlobalEmpty()
                ) : (
                    <>
                        {renderRecsForYou(data)}
                        {renderFriendsWatching(data)}
                        {renderCurrentlyWatching(data)}
                    </>
                )}
            </ScrollView>
        );
    } else {
        body = null;
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {renderHeader()}
            <SearchBarInput state={search} />
            {body}
            <RatingSheet
                visible={!!ratingTarget}
                busy={ratingBusy}
                initialRating={ratingTarget?.rating ?? null}
                onSubmit={handleRatingSubmit}
            />
            {search.overlayVisible && (
                <SearchBarOverlay
                    state={search}
                    top={insets.top + SEARCH_OVERLAY_TOP_OFFSET}
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
    },
    headerLogo: {
        // Source asset is 500 × 147 (≈ 3.4:1). Sized to roughly match
        // the previous typography.display ("Seen" wordmark) visual
        // weight — height matches the display lineHeight (38), width
        // follows aspect ratio.
        width: 130,
        height: 38,
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -6,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        fontSize: 10,
        fontWeight: '700',
    },
    scrollContent: {
        paddingBottom: spacing.xxl,
    },
    section: {
        paddingTop: spacing.lg,
    },
    sectionHeader: {
        paddingHorizontal: spacing.base,
        marginBottom: spacing.md,
    },
    // Recs for you — HERO cards. Each card is ~85% of screen width
    // with poster on the left and content on the right; the next card
    // peeks on the right edge as a swipe affordance.
    recCardsRow: {
        paddingLeft: spacing.base,
        paddingRight: spacing.base,
        paddingVertical: spacing.xs,
        gap: spacing.md,
    },
    // Solo-card wrapper: matches the multi-card row's vertical padding
    // so swapping between 1 and 2+ recs doesn't shift the section
    // height. The card width itself is passed inline by
    // renderRecHeroCard.
    recSoloRow: {
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.xs,
    },
    recHeroCard: {
        flexDirection: 'row',
        // Width is supplied inline by renderRecHeroCard so the single
        // and multi-card paths can use different sizes.
        height: REC_CARD_H,
        padding: spacing.sm,
        borderRadius: radius.md,
        borderWidth: 1,
        gap: spacing.md,
    },
    recHeroPoster: {
        width: REC_POSTER_W,
        height: REC_POSTER_H,
        borderRadius: radius.sm,
    },
    recHeroContent: {
        flex: 1,
        gap: spacing.sm,
        // Subtle inset on the right so content doesn't crowd the card
        // edge; lines up the title with the avatar column above.
        paddingRight: spacing.xs,
    },
    recHeroSenderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    recHeroSenderText: {
        // Stack the sender name (accent) over the "recommends" caption
        // (muted) so the social attribution reads as one identity
        // block.
        flex: 1,
    },
    recNote: {
        fontSize: 14,
        lineHeight: 20,
        fontStyle: 'italic',
    },
    // Friends are watching — horizontal scrolling row, no labels.
    // contentContainerStyle for the ScrollView; paddingHorizontal gives
    // both the comfortable left inset matching the section header and a
    // matching trailing breath after the last poster when scrolled to
    // the end. `gap` handles even between-poster spacing — works on
    // horizontal ScrollView contentContainer because RN lays children
    // in a flex row internally.
    friendsRowContent: {
        paddingHorizontal: FRIENDS_ROW_INSET,
        gap: FRIENDS_ROW_GAP,
    },
    friendsGridCell: {
        // Cell wraps the poster + the absolute avatar overlay so the
        // overlay can position relative to the poster's bounds.
        position: 'relative',
    },
    friendsGridPoster: {
        width: FRIENDS_ROW_POSTER_W,
        height: FRIENDS_ROW_POSTER_H,
        borderRadius: radius.sm,
    },
    friendsGridStack: {
        // Anchored inside the poster's bottom-right corner. The previous
        // -4 / -4 overhang worked on the wrapping grid (no parent clipping)
        // but the horizontal ScrollView native-clips at its cross-axis
        // bound, chopping the chip off below the cell. Insetting by
        // spacing.xs (4 pt) sits the chip cleanly inside the rounded
        // corner — same visual idiom we use on the Library grid corners.
        position: 'absolute',
        bottom: spacing.xs,
        right: spacing.xs,
        flexDirection: 'row',
        alignItems: 'center',
    },
    friendsGridStackChip: {
        // Outer = avatar + 2×border on each side. Without this the
        // border ate into the chip's content box and shifted the
        // avatar's centered letter visibly down-and-right.
        width: FRIENDS_GRID_AVATAR_SIZE + 4,
        height: FRIENDS_GRID_AVATAR_SIZE + 4,
        // Wrapper carries the 2pt cream border so each chip reads as
        // discrete against its neighbour in the stack. `overflow:
        // hidden` clips the avatar's circle to fit inside the border.
        borderRadius: (FRIENDS_GRID_AVATAR_SIZE + 4) / 2,
        borderWidth: 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
    },
    friendsGridStackOverflow: {
        // Same border + radius as a watcher chip so +N stacks
        // coherently with the avatars.
        alignItems: 'center',
        justifyContent: 'center',
    },
    friendsGridOverflowText: {
        // Scaled up alongside the avatar bump: 10 pt in a 24 pt chip's
        // 20 pt inner content area reads at the same proportional
        // weight that 9 pt had inside the previous 22 pt chip.
        fontSize: 10,
        fontWeight: '700',
    },
    // Currently watching — compact list rows: small poster + inline
    // title/relative-time + primary-action pill on the right.
    watchingList: {
        paddingHorizontal: spacing.base,
    },
    watchingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        gap: spacing.md,
    },
    watchingRowBody: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    watchingPoster: {
        width: WATCHING_POSTER_W,
        height: WATCHING_POSTER_H,
        borderRadius: radius.sm,
    },
    watchingText: {
        // Stacked title + relative-time column. flex: 1 so it fills
        // the row between the poster and the Mark-watched pill.
        flex: 1,
        gap: 2,
    },
    watchingSeparator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: WATCHING_POSTER_W + spacing.md,
    },
    markWatchedPill: {
        // Filled accent so the row's primary action reads as primary
        // on first glance. radius.full keeps the pill rounded even
        // after the theme-wide radius bump.
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.full,
    },
    // Per-section empty states — simple body copy with an inline
    // accent-colored CTA word (e.g. "Add friends", "Search to add").
    inlineEmpty: {
        marginHorizontal: spacing.base,
        padding: spacing.base,
        gap: spacing.sm,
    },
    // Inline search overlay. Absolutely positioned over the ScrollView
    // Global empty
    globalEmpty: {
        flex: 1,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xxxl,
        gap: spacing.base,
    },
    globalEmptyHeading: {
        textAlign: 'center',
    },
    globalEmptyBody: {
        textAlign: 'center',
        marginBottom: spacing.lg,
    },
    globalEmptyActions: {
        gap: spacing.sm,
    },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    secondaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
