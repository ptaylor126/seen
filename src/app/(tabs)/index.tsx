import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
import { useUnreadCount } from '@/hooks/use-unread-count';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography, type Palette } from '@/theme/theme';

type MediaType = 'movie' | 'tv';
type RecStatus = 'pending' | 'accepted' | 'watched' | 'dismissed';

interface ActivityItem {
    tmdbId: number;
    mediaType: MediaType;
    status: 'watching' | 'watched';
    watchedAt: string | null;
    title: string;
    posterPath: string | null;
}

interface FriendCard {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    attribution: string;
}

interface RecRow {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    direction: 'sent' | 'received';
    status: RecStatus;
    other: {
        handle: string;
        displayName: string;
        avatarUrl: string | null;
    };
    title: string;
}

interface HomeData {
    activity: ActivityItem | null;
    friendCards: FriendCard[];
    hasFriends: boolean;
    recs: RecRow[];
    hasLibraryItems: boolean;
}

const STATUS_PILL: Record<
    RecStatus,
    { bg: keyof Palette; fg: keyof Palette; label: string }
> = {
    pending: { bg: 'accentSubtle', fg: 'accent', label: 'Pending' },
    accepted: { bg: 'surfaceAlt', fg: 'text', label: 'Accepted' },
    watched: { bg: 'success', fg: 'textInverse', label: 'Watched' },
    dismissed: { bg: 'textMuted', fg: 'textInverse', label: 'Dismissed' },
};

const ACTIVITY_POSTER_W = 80;
const ACTIVITY_POSTER_H = 120;
const FRIEND_POSTER_W = 100;
const FRIEND_POSTER_H = 150;
const REC_AVATAR_SIZE = 44;

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
}

function formatWatchedDate(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
}

// Fetches everything for the Home screen. Two waves: a first parallel
// batch of source queries, then a second parallel batch of metadata
// lookups (friend items, profiles, TMDB titles). N+1 on the TMDB layer is
// acceptable at MVP scale; expo-image caches posters by URL so the
// repeated metadata calls are the only real cost.
async function fetchHomeData(userId: string): Promise<HomeData> {
    // ---- Wave 1: source queries
    const [
        activityResult,
        friendshipsResult,
        recsResult,
        itemsCountResult,
    ] = await Promise.all([
        supabase
            .from('items')
            .select('tmdb_id, media_type, status, updated_at, watched_at')
            .eq('user_id', userId)
            .in('status', ['watching', 'watched'])
            .order('updated_at', { ascending: false })
            .limit(10),
        supabase
            .from('friendships')
            .select('user_a_id, user_b_id')
            .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`),
        supabase
            .from('recommendations')
            .select('id, from_user_id, to_user_id, tmdb_id, media_type, status, sent_at')
            .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
            .order('sent_at', { ascending: false })
            .limit(5),
        supabase
            .from('items')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
    ]);

    if (activityResult.error) throw activityResult.error;
    if (friendshipsResult.error) throw friendshipsResult.error;
    if (recsResult.error) throw recsResult.error;
    if (itemsCountResult.error) throw itemsCountResult.error;

    const friendIds = (friendshipsResult.data ?? []).map((f) =>
        f.user_a_id === userId ? f.user_b_id : f.user_a_id,
    );

    // ---- Wave 2: dependent fetches (friend items + profiles + TMDB)
    const [friendItemsResult, recsOtherProfilesResult] = await Promise.all([
        friendIds.length > 0
            ? supabase
                  .from('items')
                  .select('user_id, tmdb_id, media_type, status, updated_at')
                  .in('user_id', friendIds)
                  .in('status', ['watching', 'watched'])
                  .order('updated_at', { ascending: false })
                  .limit(15)
            : Promise.resolve({ data: [], error: null }),
        (async () => {
            const recs = recsResult.data ?? [];
            const otherIds = new Set<string>();
            for (const r of recs) {
                const otherId =
                    r.from_user_id === userId ? r.to_user_id : r.from_user_id;
                if (otherId) otherIds.add(otherId);
            }
            if (otherIds.size === 0) {
                return { data: [], error: null };
            }
            return supabase
                .from('profiles')
                .select('id, handle, display_name, avatar_url')
                .in('id', Array.from(otherIds));
        })(),
    ]);

    if (friendItemsResult.error) throw friendItemsResult.error;
    if (recsOtherProfilesResult.error) throw recsOtherProfilesResult.error;

    // ---- Section 2: friend profiles + TMDB titles for the unique titles

    // Explicit row shape: the conditional `Promise.resolve({ data: [] })`
    // in wave 2 means TS would otherwise widen `data` to `never[]`.
    interface FriendItemRow {
        user_id: string;
        tmdb_id: number;
        media_type: string;
        status: string;
        updated_at: string;
    }
    const friendItems = (friendItemsResult.data ?? []) as FriendItemRow[];

    // Dedup by tmdb+media — show one card per title, attributed to the
    // most recent watcher (the array is already updated_at desc).
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

    // ---- Wave 3: friend display names + TMDB titles for friend cards,
    //              + TMDB titles for activity and recs
    const friendProfilesPromise =
        friendItemOwnerIds.length > 0
            ? supabase
                  .from('profiles')
                  .select('id, display_name')
                  .in('id', friendItemOwnerIds)
            : Promise.resolve({ data: [], error: null });

    const activityChoice =
        (activityResult.data ?? []).find((i) => i.status === 'watching') ??
        (activityResult.data ?? []).find((i) => i.status === 'watched');

    // Wrap the activity TMDB fetch so a single TMDB hiccup doesn't take
    // down the whole Home screen — friend cards and recs already swallow
    // per-item failures via Promise.allSettled; the activity title is the
    // last unconditional await in this chain and was the cascade source.
    // On failure: log + return null, the section just won't render.
    const activityTitlePromise: Promise<{
        title: string;
        posterPath: string | null;
    } | null> = activityChoice
        ? (activityChoice.media_type === 'movie'
              ? getMovie(activityChoice.tmdb_id).then((m) => ({
                    title: m.title,
                    posterPath: m.poster_path,
                }))
              : getTV(activityChoice.tmdb_id).then((t) => ({
                    title: t.name,
                    posterPath: t.poster_path,
                }))
          ).catch((err) => {
              console.warn('home activity title fetch failed:', err);
              return null;
          })
        : Promise.resolve(null);

    const friendTitleResults = await Promise.allSettled(
        uniqueFriendItems.map((i) =>
            i.media_type === 'movie'
                ? getMovie(i.tmdb_id).then((m) => ({
                      title: m.title,
                      posterPath: m.poster_path,
                  }))
                : getTV(i.tmdb_id).then((t) => ({
                      title: t.name,
                      posterPath: t.poster_path,
                  })),
        ),
    );

    const recs = recsResult.data ?? [];
    const recTitleResults = await Promise.allSettled(
        recs.map((r) =>
            r.media_type === 'movie'
                ? getMovie(r.tmdb_id).then((m) => m.title)
                : getTV(r.tmdb_id).then((t) => t.name),
        ),
    );

    const [friendProfilesResult, activityTitle] = await Promise.all([
        friendProfilesPromise,
        activityTitlePromise,
    ]);

    if (friendProfilesResult.error) throw friendProfilesResult.error;

    const friendDisplayNameById = new Map<string, string>(
        friendProfilesResult.data?.map((p) => [p.id, p.display_name]) ?? [],
    );

    // ---- Build sections

    const activity: ActivityItem | null =
        activityChoice && activityTitle
            ? {
                  tmdbId: activityChoice.tmdb_id,
                  mediaType: activityChoice.media_type as MediaType,
                  status: activityChoice.status as 'watching' | 'watched',
                  watchedAt: activityChoice.watched_at,
                  title: activityTitle.title,
                  posterPath: activityTitle.posterPath,
              }
            : null;

    const friendCards: FriendCard[] = [];
    uniqueFriendItems.forEach((item, i) => {
        const titleResult = friendTitleResults[i];
        if (titleResult.status !== 'fulfilled') return;
        const displayName =
            friendDisplayNameById.get(item.user_id) ?? 'A friend';
        friendCards.push({
            tmdbId: item.tmdb_id,
            mediaType: item.media_type as MediaType,
            title: titleResult.value.title,
            posterPath: titleResult.value.posterPath,
            attribution: firstName(displayName),
        });
    });

    const otherProfileById = new Map(
        recsOtherProfilesResult.data?.map((p) => [p.id, p]) ?? [],
    );

    const recRows: RecRow[] = [];
    recs.forEach((r, i) => {
        const otherId =
            r.from_user_id === userId ? r.to_user_id : r.from_user_id;
        const otherProfile = otherId ? otherProfileById.get(otherId) : null;
        const titleResult = recTitleResults[i];
        const title =
            titleResult?.status === 'fulfilled' ? titleResult.value : null;
        if (!title) return;
        recRows.push({
            id: r.id,
            tmdbId: r.tmdb_id,
            mediaType: r.media_type as MediaType,
            direction: r.from_user_id === userId ? 'sent' : 'received',
            status: r.status as RecStatus,
            other: {
                handle: otherProfile?.handle ?? 'unknown',
                displayName: otherProfile?.display_name ?? 'Former user',
                avatarUrl: otherProfile?.avatar_url ?? null,
            },
            title,
        });
    });

    return {
        activity,
        friendCards,
        hasFriends: friendIds.length > 0,
        recs: recRows,
        hasLibraryItems: (itemsCountResult.count ?? 0) > 0,
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

    function navigateToTitle(mediaType: MediaType, tmdbId: number, fromRec?: string) {
        // Object form (rather than a template-literal string) so the typed
        // router accepts it — string interpolation widens to `string` and
        // doesn't pattern-match the `/title/${...}/${...}` Href shape.
        router.push({
            pathname: '/title/[mediaType]/[tmdbId]',
            params: fromRec
                ? { mediaType, tmdbId: String(tmdbId), fromRec }
                : { mediaType, tmdbId: String(tmdbId) },
        });
    }

    // ---- Renderers

    function renderActivity(activity: ActivityItem) {
        const headerLabel =
            activity.status === 'watching' ? 'Continue watching' : 'Last watched';
        // Subline only appears for watched items with a recorded date —
        // the "stream progress" subtitle doesn't fit our show-level model,
        // so the watching case just shows the title.
        const subline =
            activity.status === 'watched' && activity.watchedAt
                ? `You watched this on ${formatWatchedDate(activity.watchedAt)}`
                : null;
        return (
            <View style={styles.section}>
                <Text style={[typography.bodyEmphasis, styles.sectionHeader, { color: palette.text }]}>
                    {headerLabel}
                </Text>
                <Pressable
                    onPress={() => navigateToTitle(activity.mediaType, activity.tmdbId)}
                    style={({ pressed }) => [
                        styles.activityCard,
                        { backgroundColor: palette.surfaceAlt },
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    {activity.posterPath ? (
                        <Image
                            source={{ uri: imageUrl(activity.posterPath, 'w185') }}
                            style={styles.activityPoster}
                            contentFit="cover"
                            transition={150}
                        />
                    ) : (
                        <View
                            style={[
                                styles.activityPoster,
                                { backgroundColor: palette.border },
                            ]}
                        />
                    )}
                    <View style={styles.activityText}>
                        <Text
                            style={[typography.bodyEmphasis, { color: palette.text }]}
                            numberOfLines={2}
                        >
                            {activity.title}
                        </Text>
                        {subline && (
                            <Text
                                style={[typography.caption, { color: palette.textMuted }]}
                                numberOfLines={2}
                            >
                                {subline}
                            </Text>
                        )}
                    </View>
                </Pressable>
            </View>
        );
    }

    function renderFriendsWatching(data: HomeData) {
        return (
            <View style={styles.section}>
                <Text style={[typography.bodyEmphasis, styles.sectionHeader, { color: palette.text }]}>
                    Friends are watching
                </Text>
                {data.friendCards.length > 0 ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.friendsRow}
                    >
                        {data.friendCards.map((card) => (
                            <Pressable
                                key={`${card.mediaType}-${card.tmdbId}`}
                                onPress={() => navigateToTitle(card.mediaType, card.tmdbId)}
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
                        <Text
                            style={[typography.body, { color: palette.textMuted }]}
                        >
                            Add friends to see what they&apos;re watching.
                        </Text>
                        <Pressable
                            onPress={() => router.push({ pathname: '/friends' })}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [
                                styles.emptyLink,
                                pressed && { opacity: 0.6 },
                            ]}
                        >
                            <Text
                                style={[typography.body, { color: palette.accent }]}
                            >
                                Go to Friends
                            </Text>
                        </Pressable>
                    </View>
                )}
            </View>
        );
    }

    function renderRecs(data: HomeData) {
        return (
            <View style={styles.section}>
                <Text style={[typography.bodyEmphasis, styles.sectionHeader, { color: palette.text }]}>
                    Recent recommendations
                </Text>
                {data.recs.length > 0 ? (
                    <View style={styles.recList}>
                        {data.recs.map((rec, i) => {
                            const pill = STATUS_PILL[rec.status];
                            const directionLabel =
                                rec.direction === 'received'
                                    ? `From ${firstName(rec.other.displayName)}`
                                    : `To ${firstName(rec.other.displayName)}`;
                            return (
                                <View key={rec.id}>
                                    {i > 0 && (
                                        <View
                                            style={[
                                                styles.recSeparator,
                                                { backgroundColor: palette.border },
                                            ]}
                                        />
                                    )}
                                    <Pressable
                                        onPress={() =>
                                            navigateToTitle(
                                                rec.mediaType,
                                                rec.tmdbId,
                                                rec.direction === 'received' &&
                                                    rec.status === 'pending'
                                                    ? rec.id
                                                    : undefined,
                                            )
                                        }
                                        style={({ pressed }) => [
                                            styles.recRow,
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        <Avatar
                                            avatarUrl={rec.other.avatarUrl}
                                            displayName={rec.other.displayName}
                                            size={REC_AVATAR_SIZE}
                                        />
                                        <View style={styles.recText}>
                                            <Text
                                                style={[
                                                    typography.bodyEmphasis,
                                                    { color: palette.text },
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {rec.title}
                                            </Text>
                                            <Text
                                                style={[
                                                    typography.caption,
                                                    { color: palette.textMuted },
                                                ]}
                                            >
                                                {directionLabel}
                                            </Text>
                                        </View>
                                        <View
                                            style={[
                                                styles.statusPill,
                                                { backgroundColor: palette[pill.bg] },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    typography.micro,
                                                    {
                                                        color: palette[pill.fg],
                                                        fontWeight: '600',
                                                    },
                                                ]}
                                            >
                                                {pill.label}
                                            </Text>
                                        </View>
                                    </Pressable>
                                </View>
                            );
                        })}
                    </View>
                ) : (
                    <View style={styles.inlineEmpty}>
                        <Text
                            style={[typography.body, { color: palette.textMuted }]}
                        >
                            No recommendations yet. Send one or wait for friends to
                            recommend.
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
                        onPress={() => router.push({ pathname: '/library' })}
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
            data.recs.length === 0;
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
                        {data.activity && renderActivity(data.activity)}
                        {renderFriendsWatching(data)}
                        {renderRecs(data)}
                    </>
                )}
            </ScrollView>
        );
    } else {
        body = null;
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Seen" unreadCount={unreadCount} />
            {body}
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
    // Activity (Section 1)
    activityCard: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: spacing.base,
        padding: spacing.md,
        borderRadius: radius.md,
        gap: spacing.md,
    },
    activityPoster: {
        width: ACTIVITY_POSTER_W,
        height: ACTIVITY_POSTER_H,
        borderRadius: radius.sm,
    },
    activityText: {
        flex: 1,
        gap: spacing.xs,
    },
    // Friends (Section 2)
    friendsRow: {
        paddingHorizontal: spacing.base,
        gap: spacing.md,
    },
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
    // Recs (Section 3)
    recList: {
        paddingHorizontal: spacing.base,
    },
    recRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    recText: {
        flex: 1,
        gap: spacing.xs,
    },
    recSeparator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: REC_AVATAR_SIZE + spacing.md,
    },
    statusPill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
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
