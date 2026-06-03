import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Mail, Search, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    FlatList,
    Keyboard,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { RatingSheet } from '@/components/rating-sheet';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { applyWatchedRating, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Same shape as the /library/add modal: surface only movies and TV
// with a poster — TMDB returns plenty of poster-less rows that don't
// belong in a results list.
type SearchableItem =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

const SEARCH_DEBOUNCE_MS = 300;
// Distance from the SafeArea top inset to the bottom of the search bar.
// Used to position the search results overlay's top edge just under the
// input. Sized from the header + searchBar style values below:
// header padding (12 + 12) + display lineHeight (38) + searchBar
// marginTop (8) + searchBar height (44) = 114; rounded to 116 for a
// hairline of breathing room.
const SEARCH_SHEET_TOP_OFFSET = 116;
const SEARCH_RESULT_POSTER_W = 56;
const SEARCH_RESULT_POSTER_H = 84;

interface RecForYou {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    note: string | null;
    sender: { handle: string; displayName: string; avatarUrl: string | null };
}

interface FriendCard {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    // Kept on the interface so the section's older attribution-line
    // variant remains buildable if we ever revert; the new grid
    // layout doesn't render this string directly, but uses the sender
    // info below to overlay a small avatar on the poster.
    attribution: string;
    sender: { displayName: string; avatarUrl: string | null };
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

// Friends grid — 4 posters per row, square crop. Pure visual scan;
// no labels. 8 items (2 rows of 4). justify-content: 'space-between'
// in the grid style distributes them evenly regardless of device width.
const FRIENDS_GRID_POSTER_W = 80;
const FRIENDS_GRID_POSTER_H = 80;
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

// Friends grid avatar overlay — small social attribution badge on
// each poster's bottom-right corner. 24 px reads as a "who" signal
// without competing with the poster art for attention.
const FRIENDS_GRID_AVATAR_SIZE = 24;

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
                  .in('status', ['watching', 'watched'])
                  .order('updated_at', { ascending: false })
                  .limit(40)
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

    // Dedup friend items by (media_type, tmdb_id) — show one card per
    // title, attributed to the most recent watcher (the SQL ordering
    // already has the most recent first, so the first occurrence wins).
    interface FriendItemRow {
        user_id: string;
        tmdb_id: number;
        media_type: string;
        status: string;
        updated_at: string;
        created_at: string;
        rating: number | null;
    }
    const friendItems = (friendItemsResult.data ?? []) as FriendItemRow[];
    const seenTitleKeys = new Set<string>();
    const uniqueFriendItems: FriendItemRow[] = [];
    for (const item of friendItems) {
        const key = `${item.media_type}:${item.tmdb_id}`;
        if (!seenTitleKeys.has(key)) {
            seenTitleKeys.add(key);
            uniqueFriendItems.push(item);
        }
    }

    const friendItemOwnerIds = Array.from(
        new Set(uniqueFriendItems.map((i) => i.user_id)),
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

    const friendTitlePromises = uniqueFriendItems.map((i) =>
        i.media_type === 'movie'
            ? getMovie(i.tmdb_id).then((m) => ({
                  title: m.title,
                  posterPath: m.poster_path,
              }))
            : getTV(i.tmdb_id).then((t) => ({
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
                handle: senderProfile?.handle ?? 'unknown',
                displayName: senderProfile?.display_name ?? 'Former user',
                avatarUrl: senderProfile?.avatar_url ?? null,
            },
        });
    });

    const friendCards: FriendCard[] = [];
    uniqueFriendItems.forEach((item, i) => {
        const titleResult = friendTitleResults[i];
        if (titleResult.status !== 'fulfilled') return;
        const friendProfile = friendProfileById.get(item.user_id);
        const displayName = friendProfile?.displayName ?? 'A friend';
        const verb = item.status === 'watching' ? 'is watching this' : 'watched this';
        friendCards.push({
            tmdbId: item.tmdb_id,
            mediaType: item.media_type as MediaType,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            attribution: `${firstName(displayName)} ${verb}`,
            sender: {
                displayName,
                avatarUrl: friendProfile?.avatarUrl ?? null,
            },
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

    // Inline search. The TextInput in the header lives on Home itself;
    // when focused (or whenever it holds text) the results sheet Modal
    // opens below it. The Modal's top region is a tap-to-dismiss scrim
    // so the user can swipe back to Home without committing a search.
    const homeInputRef = useRef<TextInput>(null);
    const [homeSearchQuery, setHomeSearchQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchableItem[] | null>(null);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    // 300 ms debounce + stale-result guard. Mirrors the pattern used in
    // src/app/library/add.tsx; the search is driven by the query alone,
    // so closing the modal doesn't cancel an in-flight request — the
    // stale guard's `active` flag is enough.
    useEffect(() => {
        const trimmed = homeSearchQuery.trim();
        if (!trimmed) {
            setSearchResults(null);
            setSearchError(null);
            setSearchLoading(false);
            return;
        }

        let active = true;
        setSearchLoading(true);

        const handle = setTimeout(async () => {
            try {
                const response = await searchMulti(trimmed, 1);
                if (!active) return;
                const filtered = response.results.filter(
                    (item): item is SearchableItem =>
                        (item.media_type === 'movie' || item.media_type === 'tv') &&
                        !!item.poster_path,
                );
                setSearchResults(filtered);
                setSearchError(null);
            } catch (err) {
                if (!active) return;
                setSearchResults([]);
                setSearchError(err instanceof Error ? err.message : 'Search failed');
            } finally {
                if (active) setSearchLoading(false);
            }
        }, SEARCH_DEBOUNCE_MS);

        return () => {
            active = false;
            clearTimeout(handle);
        };
    }, [homeSearchQuery]);

    function handleSearchFocus() {
        setSearchOpen(true);
    }

    function handleSearchDismiss() {
        setHomeSearchQuery('');
        setSearchResults(null);
        setSearchError(null);
        setSearchOpen(false);
        homeInputRef.current?.blur();
        Keyboard.dismiss();
    }

    function handleSearchResultTap(item: SearchableItem) {
        handleSearchDismiss();
        router.push({
            pathname: '/title/[mediaType]/[tmdbId]',
            params: {
                mediaType: item.media_type,
                tmdbId: String(item.id),
            },
        });
    }

    // CTA from the Currently watching empty state: refocus the home
    // input so the user lands directly in the search experience.
    // Fallback to the /library/add modal route on the unlikely event
    // the input ref is not yet attached.
    function handleSearchFromEmpty() {
        if (homeInputRef.current) {
            homeInputRef.current.focus();
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

    function renderSearchBar() {
        return (
            <View
                style={[
                    styles.searchBar,
                    {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                    },
                ]}
            >
                <Search
                    color={palette.textMuted}
                    size={20}
                    strokeWidth={ICON_STROKE_WIDTH}
                />
                <TextInput
                    ref={homeInputRef}
                    value={homeSearchQuery}
                    onChangeText={setHomeSearchQuery}
                    onFocus={handleSearchFocus}
                    placeholder="Search to add or find anything"
                    placeholderTextColor={palette.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    style={[styles.searchInput, typography.body, { color: palette.text }]}
                />
            </View>
        );
    }

    function renderSearchResult({ item }: { item: SearchableItem }) {
        const titleText = item.media_type === 'movie' ? item.title : item.name;
        const dateField =
            item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');
        return (
            <Pressable
                onPress={() => handleSearchResultTap(item)}
                style={({ pressed }) => [
                    styles.searchResultRow,
                    pressed && { opacity: 0.6 },
                ]}
            >
                <Image
                    source={{ uri: imageUrl(item.poster_path, 'w185') }}
                    style={styles.searchResultPoster}
                    contentFit="cover"
                    transition={150}
                />
                <View style={styles.searchResultText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {titleText}
                    </Text>
                    {metaLine ? (
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            {metaLine}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
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
                    <View style={styles.friendsGrid}>
                        {gridItems.map((card) => (
                            <Pressable
                                key={`${card.mediaType}-${card.tmdbId}`}
                                onPress={() =>
                                    navigateToTitle(card.mediaType, card.tmdbId)
                                }
                                style={({ pressed }) => [
                                    styles.friendsGridCell,
                                    pressed && { opacity: 0.6 },
                                ]}
                                accessibilityLabel={`${card.title}, from ${card.sender.displayName}`}
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
                                {/* Sender avatar overlay — small "who"
                                    signal in the bottom-right corner so
                                    the user can tell at a glance which
                                    friend's library the poster came
                                    from. The Pressable owns the tap
                                    target; the avatar is purely
                                    decorative. */}
                                <View
                                    style={[
                                        styles.friendsGridAvatar,
                                        {
                                            borderColor: palette.bg,
                                        },
                                    ]}
                                >
                                    <Avatar
                                        avatarUrl={card.sender.avatarUrl}
                                        displayName={card.sender.displayName}
                                        size={FRIENDS_GRID_AVATAR_SIZE}
                                    />
                                </View>
                            </Pressable>
                        ))}
                    </View>
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

    const searchModalVisible = searchOpen || homeSearchQuery.length > 0;
    const searchSheetTop = insets.top + SEARCH_SHEET_TOP_OFFSET;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {renderHeader()}
            {/* Search bar lives outside the ScrollView so its screen
                position is deterministic — the search results Modal
                positions its sheet directly below it via a fixed
                offset (SEARCH_SHEET_TOP_OFFSET). */}
            {renderSearchBar()}
            {body}
            <RatingSheet
                visible={!!ratingTarget}
                busy={ratingBusy}
                initialRating={ratingTarget?.rating ?? null}
                onSubmit={handleRatingSubmit}
            />
            {searchModalVisible && (
                <View
                    style={[
                        styles.searchOverlay,
                        {
                            top: searchSheetTop,
                            backgroundColor: palette.bg,
                            borderTopColor: palette.border,
                        },
                    ]}
                >
                    <Pressable
                        onPress={handleSearchDismiss}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [
                            styles.searchClose,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <X
                            color={palette.textMuted}
                            size={20}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                    {searchLoading ? (
                        <View style={styles.searchStatusBlock}>
                            <ActivityIndicator color={palette.accent} />
                        </View>
                    ) : searchResults === null ? (
                        // Empty overlay before the user types — the
                        // search input's placeholder already states
                        // the action, so a "Type to search" hint here
                        // is redundant and gets cut off behind the
                        // keyboard on shorter devices.
                        <View style={styles.searchStatusBlock} />
                    ) : searchResults.length === 0 ? (
                        <View style={styles.searchStatusBlock}>
                            <Text
                                style={[typography.body, { color: palette.textMuted }]}
                                numberOfLines={2}
                            >
                                {searchError
                                    ? searchError
                                    : `No results for "${homeSearchQuery.trim()}"`}
                            </Text>
                        </View>
                    ) : (
                        <FlatList
                            data={searchResults}
                            keyExtractor={(item) => `${item.media_type}-${item.id}`}
                            renderItem={renderSearchResult}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                            contentContainerStyle={styles.searchListContent}
                            ItemSeparatorComponent={() => (
                                <View
                                    style={[
                                        styles.searchSeparator,
                                        { backgroundColor: palette.border },
                                    ]}
                                />
                            )}
                        />
                    )}
                </View>
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
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
        paddingHorizontal: spacing.md,
        // Fully pill-shaped — search inputs read as their own object
        // class (vs. content inputs which use radius.md).
        borderRadius: radius.full,
        borderWidth: 1,
        height: 44,
    },
    searchInput: {
        flex: 1,
        // padding zeroed: the parent .searchBar height owns vertical
        // sizing so the icon and text stay perfectly aligned.
        paddingVertical: 0,
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
    // Friends are watching — 4 square posters per row, no labels.
    // space-between distributes the row evenly regardless of device
    // width; rowGap controls vertical space between rows of two.
    friendsGrid: {
        // Wrapping grid packed from the left with a fixed gap. Using
        // space-between previously meant rows with <4 items (e.g. the
        // last row of an odd count) stretched edge-to-edge with a huge
        // visual gap between two posters; columnGap holds the spacing
        // constant regardless of how many items land on a row.
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: spacing.base,
        // Symmetric column + row gap. rowGap matches columnGap so the
        // grid reads as evenly spaced, and the 16 px vertical gap
        // gives the sender-avatar overlay (which extends 4 px past
        // each poster's bottom-right corner) clear breathing room
        // before the next row's poster.
        columnGap: spacing.base,
        rowGap: spacing.base,
    },
    friendsGridCell: {
        // Cell wraps the poster + the absolute avatar overlay so the
        // overlay can position relative to the poster's bounds.
        position: 'relative',
    },
    friendsGridPoster: {
        width: FRIENDS_GRID_POSTER_W,
        height: FRIENDS_GRID_POSTER_H,
        borderRadius: radius.sm,
    },
    friendsGridAvatar: {
        // Hairline cream border tucks the avatar against the poster
        // so it reads as a chip pinned to the corner rather than
        // floating loose. -4 nudge keeps it just inside the poster
        // rounded corner while still kissing the edge.
        position: 'absolute',
        bottom: -4,
        right: -4,
        borderRadius: FRIENDS_GRID_AVATAR_SIZE / 2 + 2,
        borderWidth: 2,
        overflow: 'hidden',
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
    // body — `top` is set inline from insets.top + SEARCH_SHEET_TOP_OFFSET
    // so the overlay starts directly below the search bar. zIndex keeps
    // it above the body's ScrollView; the header + searchBar sit above
    // the overlay's top edge in normal flow, so the input stays
    // tappable while the overlay is open.
    searchOverlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        zIndex: 10,
    },
    searchClose: {
        position: 'absolute',
        top: spacing.sm,
        right: spacing.base,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
    },
    searchStatusBlock: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    searchListContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.xl,
        paddingBottom: spacing.lg,
    },
    searchResultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    searchResultPoster: {
        width: SEARCH_RESULT_POSTER_W,
        height: SEARCH_RESULT_POSTER_H,
        borderRadius: radius.sm,
    },
    searchResultText: {
        flex: 1,
        gap: spacing.xs,
    },
    searchSeparator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: SEARCH_RESULT_POSTER_W + spacing.md,
    },
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
