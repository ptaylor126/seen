import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Mail, Search } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { RatingSheet } from '@/components/rating-sheet';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { applyWatchedRating, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

interface RecForYou {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    sender: { handle: string; displayName: string; avatarUrl: string | null };
}

interface FriendCard {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    attribution: string;
}

interface WatchingItem {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    year: string;
}

interface HomeData {
    recsForYou: RecForYou[];
    friendCards: FriendCard[];
    currentlyWatching: WatchingItem[];
    hasLibraryItems: boolean;
    hasFriends: boolean;
}

const REC_CARD_W = 120;
const REC_CARD_H = 180;
const FRIEND_POSTER_W = 100;
const FRIEND_POSTER_H = 150;
const REC_AVATAR_SIZE = 18;
const WATCHING_POSTER_W = 56;
const WATCHING_POSTER_H = 84;

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
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
            .select('id, from_user_id, tmdb_id, media_type, sent_at')
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
            .select('tmdb_id, media_type, updated_at')
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
                  .select('user_id, tmdb_id, media_type, status, updated_at')
                  .in('user_id', friendIds)
                  .in('status', ['watching', 'watched'])
                  .order('updated_at', { ascending: false })
                  .limit(15)
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
                  .select('id, display_name')
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

    const friendDisplayNameById = new Map<string, string>(
        friendProfilesResult.data?.map((p) => [p.id, p.display_name]) ?? [],
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
        const displayName = friendDisplayNameById.get(item.user_id) ?? 'A friend';
        const verb = item.status === 'watching' ? 'is watching this' : 'watched this';
        friendCards.push({
            tmdbId: item.tmdb_id,
            mediaType: item.media_type as MediaType,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            attribution: `${firstName(displayName)} ${verb}`,
        });
    });

    const currentlyWatching: WatchingItem[] = [];
    watchingRows.forEach((w, i) => {
        const titleResult = watchingTitleResults[i];
        if (titleResult.status !== 'fulfilled') return;
        currentlyWatching.push({
            tmdbId: w.tmdb_id,
            mediaType: w.media_type as MediaType,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            year: titleResult.value.year,
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
    const { count: unreadCount } = useUnreadCount();

    const [data, setData] = useState<HomeData | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Rating sheet target: when present, the sheet is shown for this
    // (mediaType, tmdbId) pair. handleMarkWatched sets it after the
    // 'watching' → 'watched' transition succeeds; submission/dismiss
    // clears it.
    const [ratingTarget, setRatingTarget] = useState<{
        tmdbId: number;
        mediaType: MediaType;
    } | null>(null);
    const [ratingBusy, setRatingBusy] = useState(false);

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

            setRatingTarget({ tmdbId: item.tmdbId, mediaType: item.mediaType });
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
                    <Text
                        style={[typography.display, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        Seen
                    </Text>
                    <Pressable
                        onPress={() => router.push({ pathname: '/inbox' })}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <View>
                            <Mail color={palette.text} size={24} />
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
            <Pressable
                onPress={() => router.push({ pathname: '/library/add' })}
                style={({ pressed }) => [
                    styles.searchBar,
                    {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                        opacity: pressed ? 0.6 : 1,
                    },
                ]}
            >
                <Search color={palette.textMuted} size={20} />
                <Text
                    style={[typography.body, { color: palette.textMuted }]}
                    numberOfLines={1}
                >
                    Search to add or find anything
                </Text>
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
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.horizontalRow}
                    >
                        {data.recsForYou.map((rec) => (
                            <Pressable
                                key={rec.id}
                                onPress={() =>
                                    navigateToTitle(rec.mediaType, rec.tmdbId, rec.id)
                                }
                                style={({ pressed }) => [
                                    styles.recCard,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                {rec.posterPath ? (
                                    <Image
                                        source={{
                                            uri: imageUrl(rec.posterPath, 'w342'),
                                        }}
                                        style={styles.recPoster}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                ) : (
                                    <View
                                        style={[
                                            styles.recPoster,
                                            { backgroundColor: palette.surfaceAlt },
                                        ]}
                                    />
                                )}
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.recCardTitle,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={2}
                                >
                                    {rec.title}
                                </Text>
                                <View style={styles.recAttribution}>
                                    <Avatar
                                        avatarUrl={rec.sender.avatarUrl}
                                        displayName={rec.sender.displayName}
                                        size={REC_AVATAR_SIZE}
                                    />
                                    <Text
                                        style={[
                                            typography.micro,
                                            { color: palette.textMuted, flex: 1 },
                                        ]}
                                        numberOfLines={1}
                                    >
                                        From {firstName(rec.sender.displayName)}
                                    </Text>
                                </View>
                            </Pressable>
                        ))}
                    </ScrollView>
                ) : (
                    <View style={styles.inlineEmpty}>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            When friends recommend something, it shows up here.
                            Share your invite link to get started.
                        </Text>
                        <Pressable
                            onPress={() => router.push({ pathname: '/friends' })}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [
                                styles.emptyLink,
                                pressed && { opacity: 0.6 },
                            ]}
                        >
                            <Text style={[typography.body, { color: palette.accent }]}>
                                Invite friends
                            </Text>
                        </Pressable>
                    </View>
                )}
            </View>
        );
    }

    function renderFriendsWatching(data: HomeData) {
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
                {data.friendCards.length > 0 ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.horizontalRow}
                    >
                        {data.friendCards.map((card) => (
                            <Pressable
                                key={`${card.mediaType}-${card.tmdbId}`}
                                onPress={() =>
                                    navigateToTitle(card.mediaType, card.tmdbId)
                                }
                                style={({ pressed }) => [
                                    styles.friendCard,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                {card.posterPath ? (
                                    <Image
                                        source={{
                                            uri: imageUrl(card.posterPath, 'w185'),
                                        }}
                                        style={styles.friendPoster}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                ) : (
                                    <View
                                        style={[
                                            styles.friendPoster,
                                            { backgroundColor: palette.surfaceAlt },
                                        ]}
                                    />
                                )}
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.friendTitle,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={2}
                                >
                                    {card.title}
                                </Text>
                                <Text
                                    style={[
                                        typography.micro,
                                        { color: palette.textMuted },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {card.attribution}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                ) : (
                    <View style={styles.inlineEmpty}>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            See what your friends are watching. Add some friends to
                            fill this up.
                        </Text>
                        <Pressable
                            onPress={() => router.push({ pathname: '/friends' })}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [
                                styles.emptyLink,
                                pressed && { opacity: 0.6 },
                            ]}
                        >
                            <Text style={[typography.body, { color: palette.accent }]}>
                                Add friends
                            </Text>
                        </Pressable>
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
                            const mediaLabel =
                                item.mediaType === 'movie' ? 'Movie' : 'TV Show';
                            const metaLine = [item.year, mediaLabel]
                                .filter(Boolean)
                                .join(' · ');
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
                                            <View style={styles.watchingText}>
                                                <Text
                                                    style={[
                                                        typography.bodyEmphasis,
                                                        { color: palette.text },
                                                    ]}
                                                    numberOfLines={2}
                                                >
                                                    {item.title}
                                                </Text>
                                                {metaLine ? (
                                                    <Text
                                                        style={[
                                                            typography.caption,
                                                            {
                                                                color: palette.textMuted,
                                                            },
                                                        ]}
                                                    >
                                                        {metaLine}
                                                    </Text>
                                                ) : null}
                                            </View>
                                        </Pressable>
                                        <Pressable
                                            onPress={() => handleMarkWatched(item)}
                                            disabled={ratingBusy || !!ratingTarget}
                                            style={({ pressed }) => [
                                                styles.markWatchedButton,
                                                {
                                                    borderColor: palette.accent,
                                                    opacity:
                                                        pressed ||
                                                        ratingBusy ||
                                                        ratingTarget
                                                            ? 0.6
                                                            : 1,
                                                },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    typography.caption,
                                                    {
                                                        color: palette.accent,
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
                            Things you&apos;re in the middle of watching live here. Add
                            something to currently watching to start tracking.
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
                {renderSearchBar()}
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
            {body}
            <RatingSheet
                visible={!!ratingTarget}
                busy={ratingBusy}
                onSubmit={handleRatingSubmit}
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
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
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
    section: {
        paddingTop: spacing.lg,
    },
    sectionHeader: {
        paddingHorizontal: spacing.base,
        marginBottom: spacing.md,
    },
    horizontalRow: {
        paddingHorizontal: spacing.base,
        gap: spacing.md,
    },
    // Recs for you
    recCard: {
        width: REC_CARD_W,
        gap: spacing.xs,
    },
    recPoster: {
        width: REC_CARD_W,
        height: REC_CARD_H,
        borderRadius: radius.sm,
    },
    recCardTitle: {
        marginTop: spacing.xs,
    },
    recAttribution: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    // Friends are watching
    friendCard: {
        width: FRIEND_POSTER_W,
        gap: spacing.xs,
    },
    friendPoster: {
        width: FRIEND_POSTER_W,
        height: FRIEND_POSTER_H,
        borderRadius: radius.sm,
    },
    friendTitle: {
        marginTop: spacing.xs,
    },
    // Currently watching
    watchingList: {
        paddingHorizontal: spacing.base,
    },
    watchingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
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
        flex: 1,
        gap: spacing.xs,
    },
    watchingSeparator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: WATCHING_POSTER_W + spacing.md,
    },
    markWatchedButton: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1.5,
    },
    // Inline empty states (per-section)
    inlineEmpty: {
        marginHorizontal: spacing.base,
        padding: spacing.base,
        gap: spacing.sm,
    },
    emptyLink: {
        alignSelf: 'flex-start',
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
