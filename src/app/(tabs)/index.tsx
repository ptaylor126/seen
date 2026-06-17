import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Film, Mail } from 'lucide-react-native';
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
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
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
import { fetchTitlesByItems } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
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
    // TMDB landscape image. Null on ~0.2% of titles (2 of 861 in the
    // backfill); renderRecHeroCard falls back to a solid surfaceAlt
    // card with a faint film glyph in that case.
    backdropPath: string | null;
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
// Bumped from 200 (the old side-by-side poster+text layout's height)
// to 220 for the cinematic full-bleed backdrop card. With
// REC_CARD_W ≈ 331pt on a 390pt phone, 220pt gives ~1.5:1 — taller
// than strict 16:9 (which would be ~186pt), enough vertical space
// for the bottom gradient + title + note without cramping the
// recommender pill up top. Backdrop image is cropped via contentFit:
// 'cover' so a slightly taller-than-16:9 card just trims pixels
// from the image edges.
const REC_CARD_H = 220;
// 22pt avatar inside the top-left recommender pill on the new
// cinematic card (was 40pt in the previous side-by-side layout).
const REC_PILL_AVATAR_SIZE = 22;

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

    // ---- Wave 2: friend items + sender profiles + own watched-on-recs
    // (parallel)
    const senderIds = new Set<string>();
    for (const r of recs) {
        if (r.from_user_id) senderIds.add(r.from_user_id);
    }

    // Distinct rec'd tmdb_ids for the "filter out watched titles from
    // Recs for you" lookup. A rec for a title the user has already
    // finished watching shouldn't take up a slot in the discovery
    // carousel — the title isn't actionable as "something to watch."
    // Inbox still shows these recs (with the library-status badge)
    // because it's a sent-feed, not a discovery surface.
    const recTmdbIds = Array.from(new Set(recs.map((r) => r.tmdb_id)));

    const [friendItemsResult, senderProfilesResult, watchedRecLookupResult] =
        await Promise.all([
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
            // Own watched rows on the rec'd titles. status='watched' is
            // intentional — watchlist + watching pass through to the
            // carousel because they're still useful nudges for unfinished
            // titles; only finished-watching is filtered out. .in('tmdb_id',
            // …) may pull a slight superset (e.g. an items row for the
            // movie-550 when the rec was for tv-550) — the composite-key
            // stitch below excludes those cleanly.
            recTmdbIds.length > 0
                ? supabase
                      .from('items')
                      .select('tmdb_id, media_type')
                      .eq('user_id', userId)
                      .eq('status', 'watched')
                      .in('tmdb_id', recTmdbIds)
                : Promise.resolve({ data: [], error: null }),
        ]);

    if (friendItemsResult.error) throw friendItemsResult.error;
    if (senderProfilesResult.error) throw senderProfilesResult.error;

    // Best-effort: a query failure here would leave the watched-recs
    // set empty, falling through to "show all recs" — degraded behaviour
    // is a watched-rec slipping into the carousel, not a broken home
    // screen. Same shape as the inbox library-status enrichment.
    const watchedRecKeys = new Set<string>();
    if (watchedRecLookupResult.error) {
        console.warn(
            'home watched-recs filter fetch failed:',
            watchedRecLookupResult.error,
        );
    } else {
        for (const row of watchedRecLookupResult.data ?? []) {
            watchedRecKeys.add(`${row.media_type}:${row.tmdb_id}`);
        }
    }

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

    // ---- Wave 3: friend owner display names + batched title metadata
    //
    // Stage 4: replaced three separate Promise.allSettled-of-TMDB
    // arrays (recs / friend groups / watching) with one batched read
    // from the shared public.titles catalogue. All three sections
    // resolve from the same Map keyed by (media_type, tmdb_id). Cards
    // whose titles row is missing are skipped per section, matching
    // the prior "TMDB call failed → skip the card" semantics.
    const friendProfilesPromise =
        friendItemOwnerIds.length > 0
            ? supabase
                  .from('profiles')
                  .select('id, display_name, avatar_url')
                  .in('id', friendItemOwnerIds)
            : Promise.resolve({ data: [], error: null });

    const titleLookupItems = [
        ...recs.map((r) => ({ tmdb_id: r.tmdb_id, media_type: r.media_type })),
        ...friendShowGroups.map((g) => ({
            tmdb_id: g.tmdbId,
            media_type: g.mediaType,
        })),
        ...watchingRows.map((w) => ({
            tmdb_id: w.tmdb_id,
            media_type: w.media_type,
        })),
    ];

    const [friendProfilesResult, titleByKey] = await Promise.all([
        friendProfilesPromise,
        fetchTitlesByItems(titleLookupItems),
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
    recs.forEach((r) => {
        const key = `${r.media_type}:${r.tmdb_id}`;
        // Drop recs the user has already finished watching — they're
        // not actionable as "something to watch" in a discovery
        // carousel. Watchlist + watching status pass through (still
        // useful nudges for unfinished titles); only 'watched' is
        // filtered out.
        if (watchedRecKeys.has(key)) return;
        const titleRow = titleByKey.get(key);
        if (!titleRow) return;
        const senderProfile = r.from_user_id
            ? senderProfileById.get(r.from_user_id)
            : null;
        recsForYou.push({
            id: r.id,
            tmdbId: r.tmdb_id,
            mediaType: r.media_type as MediaType,
            title: titleRow.title ?? '',
            posterPath: titleRow.poster_path,
            backdropPath: titleRow.backdrop_path,
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
    friendShowGroups.forEach((group) => {
        const titleRow = titleByKey.get(`${group.mediaType}:${group.tmdbId}`);
        if (!titleRow) return;
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
            title: titleRow.title ?? '',
            posterPath: titleRow.poster_path,
            watchers,
            totalWatchers: watchers.length,
        });
    });

    const currentlyWatching: WatchingItem[] = [];
    watchingRows.forEach((w) => {
        const titleRow = titleByKey.get(`${w.media_type}:${w.tmdb_id}`);
        if (!titleRow) return;
        currentlyWatching.push({
            tmdbId: w.tmdb_id,
            mediaType: w.media_type as MediaType,
            rating: typeof w.rating === 'number' ? w.rating : null,
            title: titleRow.title ?? '',
            posterPath: titleRow.poster_path,
            year: titleRow.release_date
                ? titleRow.release_date.slice(0, 4)
                : '',
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
    const tabBarInset = useFloatingTabBarInset();
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

    // Cinematic hero card — full-bleed TMDB backdrop with a
    // bottom-anchored gradient so the title + note read on any image.
    // Top-left has a recommender pill (avatar + "{firstName} recommends");
    // bottom-left has the title + note. Card stays dark (image-forward)
    // in both light and dark mode regardless of palette — the backdrop
    // carries it; only the surrounding screen chrome adapts.
    //
    // Fallback for the ~0.2% of titles with no TMDB backdrop (2 of 861
    // in the backfill): solid palette.surfaceAlt with a faint Film
    // glyph, and the text/pill recolour onto light tokens. Clean and
    // intentional rather than a hacked-up version of the backdrop
    // card; rare enough that minimum-viable is the right scope.
    //
    // Shared between the single-card and multi-card render paths so a
    // change here lands in both. `cardWidth` is supplied inline —
    // REC_CARD_SOLO_W (near-full-width) when there's just one rec,
    // REC_CARD_W (~85%) when the carousel needs the next card to
    // peek and invite the swipe.
    function renderRecHeroCard(rec: RecForYou, cardWidth: number) {
        const hasBackdrop = rec.backdropPath !== null;
        // Title / note colours flip with the variant: the backdrop
        // case sits on the dark end of the gradient (white text
        // regardless of the page palette), the fallback case adapts
        // to light tokens since it's on surfaceAlt with no dark image.
        const titleColor = hasBackdrop ? '#FFFFFF' : palette.text;
        const noteColor = hasBackdrop
            ? 'rgba(255,255,255,0.82)'
            : palette.textMuted;
        return (
            <Pressable
                key={rec.id}
                onPress={() =>
                    navigateToTitle(rec.mediaType, rec.tmdbId, rec.id)
                }
                style={({ pressed }) => [
                    styles.recHeroCard,
                    { width: cardWidth },
                    pressed && { opacity: 0.85 },
                ]}
            >
                {hasBackdrop ? (
                    <>
                        <Image
                            source={{
                                uri: imageUrl(rec.backdropPath!, 'w780'),
                            }}
                            style={StyleSheet.absoluteFillObject}
                            contentFit="cover"
                            transition={150}
                        />
                        {/* Gradient: transparent at top, near-opaque
                            warm-dark at bottom. locations={[0.45, 1]}
                            keeps the upper half of the image readable
                            (where the recommender pill floats) while
                            ramping aggressively into the bottom half
                            so the title + note text always reads
                            regardless of the underlying image
                            lightness. */}
                        <LinearGradient
                            colors={[
                                'rgba(10,6,10,0)',
                                'rgba(10,6,10,0.92)',
                            ]}
                            locations={[0.45, 1]}
                            style={StyleSheet.absoluteFillObject}
                        />
                    </>
                ) : (
                    <View
                        style={[
                            StyleSheet.absoluteFillObject,
                            styles.recHeroFallback,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    >
                        <Film
                            color={palette.textMuted}
                            size={64}
                            strokeWidth={1.25}
                            style={styles.recHeroFallbackIcon}
                        />
                    </View>
                )}

                {/* Recommender pill, top-left. Solid palette.accent
                    (plum) in BOTH the backdrop and fallback variants
                    — the recommender is the whole social-signal point
                    of the card, so it gets a deliberate brand-coloured
                    chip rather than blending into the image or the
                    surfaceAlt wash. White firstName + 85%-white
                    "recommends" gives the two-step hierarchy inside
                    the pill (name = primary, verb = supporting) at
                    legible contrast on plum. */}
                <View
                    style={[
                        styles.recommenderPill,
                        { backgroundColor: palette.accent },
                    ]}
                >
                    <Avatar
                        avatarUrl={rec.sender.avatarUrl}
                        displayName={rec.sender.displayName}
                        seedId={rec.sender.userId}
                        size={REC_PILL_AVATAR_SIZE}
                    />
                    <Text
                        style={[
                            typography.caption,
                            { color: 'rgba(255,255,255,0.85)' },
                        ]}
                        numberOfLines={1}
                    >
                        <Text
                            style={[
                                typography.caption,
                                styles.recommenderName,
                                { color: '#FFFFFF' },
                            ]}
                        >
                            {firstName(rec.sender.displayName)}
                        </Text>{' '}
                        recommends
                    </Text>
                </View>

                {/* Title + note, bottom-left, sitting on the dark end
                    of the gradient. Title uses typography.heading;
                    note is italic caption-sized in curly quotes.
                    Both numberOfLines={2} so a long note doesn't push
                    the title or vice versa. */}
                <View style={styles.recHeroContent}>
                    <Text
                        style={[typography.heading, { color: titleColor }]}
                        numberOfLines={2}
                    >
                        {rec.title}
                    </Text>
                    {rec.note ? (
                        <Text
                            style={[
                                styles.recNote,
                                { color: noteColor },
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
                {/* No "Recs for you" section heading. The card already
                    leads with "{firstName} recommends" in the plum
                    pill, so a separate heading would just restate the
                    same idea louder. Leading the screen with the
                    cinematic card (no label) is a more confident
                    image-forward open. styles.section's
                    paddingTop: spacing.lg keeps a 24pt gap below the
                    search bar so the card doesn't jam. The other
                    sections (Friends are watching, Currently watching)
                    keep their headings — those do real structural
                    work separating sections. */}
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
                // Inline paddingBottom = floating-nav clearance (bar
                // height + bottom gap + safe-area). Replaces the
                // previous static spacing.xxl — the floating bar
                // provides its own trailing breath via its inset.
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: tabBarInset },
                ]}
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
            {/* Persistent gap below the search bar so scroll content
                doesn't tuck flush against it as the user scrolls.
                SearchBarInput is a sibling of the ScrollView (not
                inside it / not absolutely-positioned), so the
                ScrollView's frame top edge sits at the bottom of
                this wrapper. Without the wrapper's marginBottom, the
                first section's paddingTop (24pt from styles.section)
                only provides clearance at scroll position 0 —
                scrolled past, the next item sits flush. The wrapper
                puts a bg-coloured strip between the search bar and
                the ScrollView frame that persists across all scroll
                positions. */}
            <View style={styles.searchBarWrapper}>
                <SearchBarInput state={search} />
            </View>
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
    searchBarWrapper: {
        // Persistent gap between the pinned search bar and the
        // ScrollView frame below it — see the JSX comment for the
        // mechanism. spacing.md (12pt) is the minimum that reads as
        // deliberate breath without feeling like a void; tune up to
        // spacing.base (16pt) if the on-device pass shows it still
        // feels cramped.
        marginBottom: spacing.md,
    },
    scrollContent: {
        // paddingBottom set inline at the consuming ScrollView via
        // useFloatingTabBarInset (replaces the previous static
        // spacing.xxl that was sized for the old non-floating tab bar).
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
        // Width is supplied inline by renderRecHeroCard so the single
        // and multi-card paths can use different sizes. Card is a
        // fixed-height tile that hosts a full-bleed backdrop (or
        // fallback wash) behind absolutely-positioned overlay
        // children — overflow: 'hidden' clips both the image and the
        // gradient to the rounded corners.
        height: REC_CARD_H,
        borderRadius: radius.md,
        overflow: 'hidden',
        position: 'relative',
    },
    recHeroFallback: {
        // Used only when backdropPath is null. Centers the Film glyph
        // as a quiet hint that the card is intentionally image-less,
        // rather than looking like a broken/missing image.
        alignItems: 'center',
        justifyContent: 'center',
    },
    recHeroFallbackIcon: {
        // Quiet enough to read as decoration, not a primary affordance.
        opacity: 0.3,
    },
    recommenderPill: {
        // Top-left badge with the recommender's avatar + "{firstName}
        // recommends". Floats over the card, so absolute positioning
        // with a generous top/left inset. maxWidth keeps long display
        // names from running off the right edge into the dead zone
        // where there's no peek visual.
        position: 'absolute',
        top: spacing.md,
        left: spacing.md,
        maxWidth: '85%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        // Asymmetric horizontal padding: tight on the left (the avatar
        // already provides visual weight) and roomier on the right so
        // the text doesn't crowd the pill edge.
        paddingLeft: spacing.xs,
        paddingRight: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    recommenderName: {
        // Slight weight bump on the firstName chunk inside the
        // recommender pill — separates the name from the "recommends"
        // trailing text without needing a different typography token.
        fontWeight: '600',
    },
    recHeroContent: {
        // Bottom-anchored title + note block. Sits inside the dark
        // end of the gradient on the backdrop variant; against
        // surfaceAlt on the fallback. Stretches to the card edges
        // minus the standard gutter so titles can use the full width.
        position: 'absolute',
        bottom: spacing.md,
        left: spacing.md,
        right: spacing.md,
        gap: spacing.xs,
    },
    recNote: {
        // Italic caption-sized note with light-on-dark colour applied
        // inline (varies between backdrop and fallback variants). The
        // typography token doesn't include italic by default so we
        // set it here.
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
