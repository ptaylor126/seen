import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Send, UserPlus } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { formatRatingStars, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type ItemStatus = 'watchlist' | 'watching' | 'watched';

interface FriendProfile {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

interface ItemRow {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    rating: number | null;
    watchedAt: string | null;
    title: string;
    posterPath: string | null;
    year: string;
}

// Three-state resolution machine. Renders the whole screen off this:
//   - loading → spinner
//   - not-found → handle resolves to no profile (or fetch failed)
//   - not-friends → profile exists but no friendship row
//   - friends → full library view
type ResolvedState =
    | { kind: 'loading' }
    | { kind: 'not-found' }
    | { kind: 'not-friends'; profile: FriendProfile }
    | { kind: 'friends'; profile: FriendProfile; friendshipCreatedAt: string };

const TABS: readonly ItemStatus[] = ['watchlist', 'watching', 'watched'] as const;
const TAB_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};

const POSTER_W = 56;
const POSTER_H = 84;
const AVATAR_SIZE = 80;

// "Friends since May 2026" — a single coarse line is enough; specific
// days feel surveillance-y for a casual social product.
function formatFriendsSince(iso: string): string {
    const d = new Date(iso);
    const month = d.toLocaleString('en-US', { month: 'long' });
    return `Friends since ${month} ${d.getFullYear()}`;
}

function emptyMessage(status: ItemStatus, displayName: string): string {
    switch (status) {
        case 'watchlist':
            return `${displayName} hasn't added anything to their watchlist yet.`;
        case 'watching':
            return `${displayName} isn't currently watching anything.`;
        case 'watched':
            return `${displayName} hasn't marked anything watched yet.`;
    }
}

// N+1 TMDB metadata fetch — same trade-off as Library. expo-image
// caches posters by URL; only the JSON metadata is the real cost.
async function fetchItemMeta(tmdbId: number, mediaType: MediaType) {
    if (mediaType === 'movie') {
        const m = await getMovie(tmdbId);
        return {
            title: m.title,
            posterPath: m.poster_path,
            year: m.release_date ? m.release_date.slice(0, 4) : '',
        };
    }
    const t = await getTV(tmdbId);
    return {
        title: t.name,
        posterPath: t.poster_path,
        year: t.first_air_date ? t.first_air_date.slice(0, 4) : '',
    };
}

export default function FriendDetailScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
    // Handles are stored lowercase in the DB (per the handle column's
    // CHECK constraint). Defensively coerce the URL param so that a
    // capitalized link from somewhere still resolves.
    const handle = (rawHandle ?? '').toLowerCase();

    const [state, setState] = useState<ResolvedState>({ kind: 'loading' });
    const [activeTab, setActiveTab] = useState<ItemStatus>('watched');
    const [items, setItems] = useState<ItemRow[]>([]);
    const [itemsLoading, setItemsLoading] = useState(false);
    const [itemsError, setItemsError] = useState<string | null>(null);

    // ---- Phase 1: resolve friend by handle + friendship status.
    // useFocusEffect so we re-resolve on return (e.g. user accepted a
    // request elsewhere and came back). Stale-guard via `active`.
    useFocusEffect(
        useCallback(() => {
            if (!handle) {
                setState({ kind: 'not-found' });
                return;
            }
            let active = true;
            (async () => {
                try {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    const userId = session?.user.id;
                    if (!userId) throw new Error('Not authenticated');

                    const { data: profileData, error: profileError } =
                        await supabase
                            .from('profiles')
                            .select('id, display_name, handle, avatar_url')
                            .eq('handle', handle)
                            .maybeSingle();
                    if (!active) return;
                    if (profileError) throw profileError;
                    if (!profileData) {
                        setState({ kind: 'not-found' });
                        return;
                    }

                    // Looking at your own handle via this route — bounce
                    // to the proper profile tab instead of rendering an
                    // awkward "you're not friends with yourself" page.
                    if (profileData.id === userId) {
                        router.replace('/(tabs)/profile');
                        return;
                    }

                    const profile: FriendProfile = {
                        id: profileData.id,
                        handle: profileData.handle,
                        displayName: profileData.display_name,
                        avatarUrl: profileData.avatar_url,
                    };

                    // Friendships are stored with (least, greatest) so we
                    // can use a direct primary-key match instead of an
                    // OR query.
                    const least = userId < profile.id ? userId : profile.id;
                    const greatest = userId > profile.id ? userId : profile.id;
                    const { data: friendship, error: friendshipError } =
                        await supabase
                            .from('friendships')
                            .select('created_at')
                            .eq('user_a_id', least)
                            .eq('user_b_id', greatest)
                            .maybeSingle();
                    if (!active) return;
                    if (friendshipError) throw friendshipError;

                    if (!friendship) {
                        setState({ kind: 'not-friends', profile });
                        return;
                    }

                    setState({
                        kind: 'friends',
                        profile,
                        friendshipCreatedAt: friendship.created_at,
                    });
                } catch (err) {
                    if (!active) return;
                    console.error('friend profile resolve failed:', err);
                    // We don't differentiate transient errors from genuine
                    // misses here — "not found" is the safest user-facing
                    // landing for an unresolvable handle.
                    setState({ kind: 'not-found' });
                }
            })();
            return () => {
                active = false;
            };
        }, [handle, router]),
    );

    // ---- Phase 2: fetch items for the active tab (only when friends).
    // is_private is filtered both client-side (explicit) and by RLS
    // (defence in depth); RLS is the authoritative check.
    useEffect(() => {
        if (state.kind !== 'friends') return;
        let active = true;
        setItemsLoading(true);
        setItemsError(null);
        (async () => {
            try {
                const { data: rows, error } = await supabase
                    .from('items')
                    .select('id, tmdb_id, media_type, rating, watched_at, updated_at')
                    .eq('user_id', state.profile.id)
                    .eq('status', activeTab)
                    .eq('is_private', false)
                    .order('updated_at', { ascending: false })
                    .limit(100);
                if (!active) return;
                if (error) throw error;

                const placeholders: ItemRow[] = (rows ?? []).map((r) => ({
                    id: r.id,
                    tmdbId: r.tmdb_id,
                    mediaType: r.media_type as MediaType,
                    rating: typeof r.rating === 'number' ? r.rating : null,
                    watchedAt: r.watched_at,
                    title: '',
                    posterPath: null,
                    year: '',
                }));
                setItems(placeholders);

                // Resolve TMDB metadata in parallel. allSettled so one
                // bad lookup doesn't blank the whole list.
                const metas = await Promise.allSettled(
                    placeholders.map((r) => fetchItemMeta(r.tmdbId, r.mediaType)),
                );
                if (!active) return;
                setItems(
                    placeholders.map((r, i) => {
                        const meta = metas[i];
                        if (meta.status === 'fulfilled') {
                            return {
                                ...r,
                                title: meta.value.title,
                                posterPath: meta.value.posterPath,
                                year: meta.value.year,
                            };
                        }
                        return r;
                    }),
                );
            } catch (err) {
                if (!active) return;
                console.error('friend items fetch failed:', err);
                setItemsError(
                    err instanceof Error ? err.message : 'Failed to load',
                );
            } finally {
                if (active) setItemsLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [state, activeTab]);

    function renderRow({ item }: { item: ItemRow }) {
        const mediaLabel = item.mediaType === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [item.year, mediaLabel].filter(Boolean).join(' · ');
        const watchedDate = item.watchedAt
            ? new Date(item.watchedAt).toLocaleDateString()
            : '';
        const ratingDisplay =
            item.rating !== null ? formatRatingStars(item.rating) : '';
        const watchedLine = [ratingDisplay, watchedDate]
            .filter(Boolean)
            .join(' · ');
        const showWatchedLine = activeTab === 'watched' && watchedLine.length > 0;
        return (
            <Pressable
                onPress={() =>
                    router.push({
                        pathname: '/title/[mediaType]/[tmdbId]',
                        params: {
                            mediaType: item.mediaType,
                            tmdbId: String(item.tmdbId),
                        },
                    })
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                {item.posterPath ? (
                    <Image
                        source={{ uri: imageUrl(item.posterPath, 'w185') }}
                        style={styles.poster}
                        contentFit="cover"
                        transition={150}
                    />
                ) : (
                    <View
                        style={[
                            styles.poster,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    />
                )}
                <View style={styles.rowText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {item.title}
                    </Text>
                    {metaLine ? (
                        <Text
                            style={[typography.caption, { color: palette.textMuted }]}
                        >
                            {metaLine}
                        </Text>
                    ) : null}
                    {showWatchedLine ? (
                        <Text
                            style={[typography.caption, { color: palette.textMuted }]}
                        >
                            {watchedLine}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    // ---- Render branches per state.

    const backButton = (
        <Pressable
            onPress={() => router.back()}
            hitSlop={spacing.sm}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
            <ChevronLeft
                color={palette.accent}
                size={28}
                strokeWidth={ICON_STROKE_WIDTH}
            />
        </Pressable>
    );

    if (state.kind === 'loading') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            </SafeAreaView>
        );
    }

    if (state.kind === 'not-found') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.fillCenter}>
                    <Text
                        style={[
                            typography.heading,
                            styles.centerText,
                            { color: palette.text },
                        ]}
                    >
                        User not found
                    </Text>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        @{rawHandle ?? 'this handle'} doesn&apos;t exist on Seen.
                    </Text>
                </View>
            </SafeAreaView>
        );
    }

    if (state.kind === 'not-friends') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.profileBlock}>
                    <Avatar
                        avatarUrl={state.profile.avatarUrl}
                        displayName={state.profile.displayName}
                        seedId={state.profile.id}
                        size={AVATAR_SIZE}
                    />
                    <Text
                        style={[typography.heading, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {state.profile.displayName}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                    >
                        @{state.profile.handle}
                    </Text>
                </View>
                <View style={styles.notFriendsBlock}>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        You&apos;re not friends with @{state.profile.handle}. Add
                        them as a friend to see their library.
                    </Text>
                    <Pressable
                        onPress={() => router.push('/friends/add')}
                        style={({ pressed }) => [
                            styles.primaryButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <UserPlus
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
                            Add friend
                        </Text>
                    </Pressable>
                </View>
            </SafeAreaView>
        );
    }

    // ---- state.kind === 'friends'
    const { profile, friendshipCreatedAt } = state;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.profileBlock}>
                    <Avatar
                        avatarUrl={profile.avatarUrl}
                        displayName={profile.displayName}
                        seedId={profile.id}
                        size={AVATAR_SIZE}
                    />
                    <Text
                        style={[typography.heading, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {profile.displayName}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                    >
                        @{profile.handle}
                    </Text>
                    <Text
                        style={[typography.micro, { color: palette.textMuted }]}
                    >
                        {formatFriendsSince(friendshipCreatedAt)}
                    </Text>
                    <Pressable
                        onPress={() =>
                            // Launches the title-picker with this friend
                            // marked as the recommendation target. After
                            // the user picks a title, library/add forwards
                            // to the recommend modal with preselect=<id>
                            // so the recipient is pre-checked.
                            router.push({
                                pathname: '/library/add',
                                params: { recommendTo: profile.id },
                            })
                        }
                        style={({ pressed }) => [
                            styles.recommendButton,
                            {
                                borderColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Send
                            color={palette.accent}
                            size={16}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                        <Text
                            style={[typography.bodyEmphasis, { color: palette.accent }]}
                        >
                            Recommend something
                        </Text>
                    </Pressable>
                </View>
            </SafeAreaView>

            <View style={styles.tabs}>
                {TABS.map((tab) => {
                    const isActive = activeTab === tab;
                    return (
                        <Pressable
                            key={tab}
                            onPress={() => setActiveTab(tab)}
                            style={({ pressed }) => [
                                styles.tabPill,
                                {
                                    backgroundColor: isActive
                                        ? palette.accent
                                        : 'transparent',
                                    borderColor: palette.accent,
                                    opacity: pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    {
                                        color: isActive
                                            ? palette.textInverse
                                            : palette.accent,
                                    },
                                ]}
                            >
                                {TAB_LABELS[tab]}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>

            {itemsLoading ? (
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : itemsError ? (
                <View style={styles.fillCenter}>
                    <Text
                        style={[typography.body, { color: palette.error }]}
                        numberOfLines={3}
                    >
                        {itemsError}
                    </Text>
                </View>
            ) : items.length === 0 ? (
                <View style={styles.fillCenter}>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        {emptyMessage(activeTab, profile.displayName)}
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
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    headerBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
    profileBlock: {
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
        gap: spacing.xs,
    },
    notFriendsBlock: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        alignItems: 'center',
        gap: spacing.lg,
    },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        gap: spacing.sm,
    },
    centerText: {
        textAlign: 'center',
    },
    primaryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.full,
    },
    recommendButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
        borderRadius: radius.full,
        borderWidth: 1.5,
        marginTop: spacing.md,
    },
    tabs: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
    },
    tabPill: {
        flex: 1,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.lg,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    poster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: POSTER_W + spacing.md,
    },
});
