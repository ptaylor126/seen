import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
    ChevronLeft,
    Search as SearchIcon,
    Send,
    UserPlus,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ViewControls } from '@/components/view-controls';
import {
    type LibraryGridCols,
    useLibraryView,
} from '@/lib/library-view';
import { TMDB_GENRE_NAMES } from '@/lib/genres';
import { formatRatingStars, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import { useLibraryFilters } from '@/lib/use-library-filters';
import { LibraryFilterControls } from '@/components/library-filter-controls';
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
    createdAt: string;
    title: string;
    posterPath: string | null;
    year: string;
    originalLanguage: string | null;
    genreIds: number[] | null;
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

// Grid sizing — mirrors the Library tab so a friend's grid looks
// identical to your own at the same density setting. Kept locally
// rather than imported so this screen stays a self-contained route;
// the numbers would only diverge if the Library tweaks them, and
// noticing that drift on review is fine.
const POSTER_ASPECT = 1.5; // 2:3 poster
const GRID_GAP_BY_COLS: Record<LibraryGridCols, number> = {
    2: spacing.base,
    3: spacing.sm,
    4: spacing.sm,
};

function getGridCellWidth(cols: LibraryGridCols, screenWidth: number): number {
    const gap = GRID_GAP_BY_COLS[cols];
    const usable = screenWidth - 2 * spacing.base;
    return Math.floor((usable - (cols - 1) * gap) / cols);
}

// Leading-star variant — "★4.5" reads tighter at small chip sizes than
// the trailing-star "4.5★" used in list rows. Mirrors the Library tab.
function compactRatingStars(rating: number): string {
    return `★${rating / 2}`;
}

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

    // Shared filter / sort / search state — same hook the own library
    // (src/app/(tabs)/library.tsx) uses, so the two screens stay in
    // lockstep. Called at the top so the hook is invoked
    // unconditionally regardless of the resolution state below; when
    // items is still [] (loading / not-found / not-friends branches),
    // the hook's memos return empty arrays and its effects no-op.
    const filters = useLibraryFilters<ItemRow>(items, activeTab);

    // Global library view mode (persisted via AsyncStorage). Switching
    // here updates the same setting Library tab reads from — flipping
    // grid/list on a friend's profile changes it on your own library
    // too. Density (gridCols) is part of the same shared setting.
    const { mode, gridCols, setMode, setGridCols } = useLibraryView();
    const screenWidth = Dimensions.get('window').width;

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
    // visibility is filtered both client-side (explicit) and by RLS
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
                    .select('id, tmdb_id, media_type, rating, watched_at, updated_at, created_at')
                    .eq('user_id', state.profile.id)
                    .eq('status', activeTab)
                    .eq('visibility', 'friends')
                    .order('updated_at', { ascending: false });
                // .limit(100) removed (step 4 parity work): the cap
                // would silently truncate filter / sort / genre
                // results to "the first 100 by recency", which is
                // wrong now that filtering moved client-side. Items
                // rows are small (~80 bytes); the titles join is
                // already batched. Alpha-scale safe.
                if (!active) return;
                if (error) throw error;

                // Stage 4: pull title metadata from the shared
                // public.titles catalogue in one batched query (down
                // from N per-item TMDB calls). Missing key → empty
                // strings + null poster, the same placeholder shape
                // the prior per-item TMDB-failure path landed on.
                const titleByKey = await fetchTitlesByItems(rows ?? []);
                if (!active) return;
                const resolved: ItemRow[] = (rows ?? []).map((r) => {
                    const titleRow = titleByKey.get(
                        `${r.media_type}:${r.tmdb_id}`,
                    );
                    return {
                        id: r.id,
                        tmdbId: r.tmdb_id,
                        mediaType: r.media_type as MediaType,
                        rating: typeof r.rating === 'number' ? r.rating : null,
                        watchedAt: r.watched_at,
                        createdAt: r.created_at,
                        title: titleRow?.title ?? '',
                        posterPath: titleRow?.poster_path ?? null,
                        year: titleRow?.release_date
                            ? titleRow.release_date.slice(0, 4)
                            : '',
                        originalLanguage: titleRow?.original_language ?? null,
                        genreIds: titleRow?.genre_ids ?? null,
                    };
                });
                setItems(resolved);
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

    function renderGridCell({ item }: { item: ItemRow }) {
        const cellWidth = getGridCellWidth(gridCols, screenWidth);
        const cellHeight = Math.floor(cellWidth * POSTER_ASPECT);
        const showRating = activeTab === 'watched' && item.rating !== null;
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
                style={({ pressed }) => [
                    { width: cellWidth, height: cellHeight },
                    styles.gridCell,
                    pressed && { opacity: 0.6 },
                ]}
                accessibilityLabel={item.title}
            >
                {item.posterPath ? (
                    <Image
                        source={{ uri: imageUrl(item.posterPath, 'w342') }}
                        style={[
                            styles.gridPoster,
                            { width: cellWidth, height: cellHeight },
                        ]}
                        contentFit="cover"
                        transition={150}
                    />
                ) : (
                    <View
                        style={[
                            styles.gridPoster,
                            {
                                width: cellWidth,
                                height: cellHeight,
                                backgroundColor: palette.surfaceAlt,
                            },
                        ]}
                    />
                )}
                {showRating && item.rating !== null ? (
                    <View
                        style={[
                            styles.gridRatingChip,
                            { backgroundColor: palette.bg },
                        ]}
                    >
                        <Text
                            style={[
                                styles.gridRatingText,
                                { color: palette.text },
                            ]}
                        >
                            {compactRatingStars(item.rating)}
                        </Text>
                    </View>
                ) : null}
            </Pressable>
        );
    }

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
                <View style={styles.headerBar}>
                    {backButton}
                    <View style={styles.headerBarRight}>
                        <ViewControls
                            mode={mode}
                            gridCols={gridCols}
                            onModeChange={setMode}
                            onGridColsChange={setGridCols}
                            palette={palette}
                        />
                    </View>
                </View>
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

            {/* Local title search — mirrors the library tab's local-
                filter bar, minus the `+` button + add-overlay (you
                can't add to someone else's library). Wired to the
                shared hook's localQuery state. */}
            <View
                style={[
                    styles.searchBar,
                    {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                    },
                ]}
            >
                <SearchIcon
                    color={palette.textMuted}
                    size={20}
                    strokeWidth={ICON_STROKE_WIDTH}
                />
                <TextInput
                    value={filters.localQuery}
                    onChangeText={filters.setLocalQuery}
                    placeholder={`Search ${profile.displayName}'s library`}
                    placeholderTextColor={palette.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    style={[
                        styles.searchInput,
                        typography.body,
                        { color: palette.text },
                    ]}
                />
            </View>

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

            {/* Shared filter / sort / genre controls — same component
                the own library uses (src/components/library-filter-
                controls.tsx). State + filtering logic in
                useLibraryFilters above; this is pure presentation. */}
            <LibraryFilterControls
                palette={palette}
                mediaFilter={filters.mediaFilter}
                setMediaFilter={filters.setMediaFilter}
                sortBy={filters.sortBy}
                setSortBy={filters.setSortBy}
                availableSortOptions={filters.availableSortOptions}
                genreFilter={filters.genreFilter}
                setGenreFilter={filters.setGenreFilter}
                genreStripOpen={filters.genreStripOpen}
                setGenreStripOpen={filters.setGenreStripOpen}
                availableGenres={filters.availableGenres}
            />

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
            ) : filters.visibleRows.length === 0 ? (
                // Three sub-cases share this branch, in priority order:
                //   1. Local query present → "no matches in @handle's
                //      library" (covers the typed-search empty case).
                //   2. Genre filter active → "No {genre} titles."
                //   3. Otherwise → the existing per-tab default copy
                //      (also covers an empty media-filter combination,
                //      same as the own library does — the active media
                //      filter is visible in the controls row, so the
                //      copy doesn't need to spell out which filter is
                //      narrowing the view).
                <View style={styles.fillCenter}>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        {filters.localQuery.trim().length > 0
                            ? `No matches in @${profile.handle}'s library.`
                            : filters.genreFilter !== null
                              ? `No ${TMDB_GENRE_NAMES.get(filters.genreFilter) ?? 'matching'} titles.`
                              : emptyMessage(activeTab, profile.displayName)}
                    </Text>
                </View>
            ) : mode === 'list' ? (
                <FlatList
                    key="list"
                    data={filters.visibleRows}
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
            ) : (
                // FlatList can't change numColumns in place — key
                // includes the column count so density changes trigger
                // a clean unmount + remount.
                <FlatList
                    key={`grid-${gridCols}`}
                    data={filters.visibleRows}
                    keyExtractor={(item) => item.id}
                    renderItem={renderGridCell}
                    numColumns={gridCols}
                    contentContainerStyle={styles.gridContent}
                    columnWrapperStyle={{
                        columnGap: GRID_GAP_BY_COLS[gridCols],
                    }}
                    ItemSeparatorComponent={() => (
                        <View style={{ height: GRID_GAP_BY_COLS[gridCols] }} />
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
    headerBarRight: {
        // Push the view-controls cluster to the right edge of the
        // header bar. The back button sits at the left; this slot is
        // its mirror.
        marginLeft: 'auto',
    },
    profileBlock: {
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
        gap: spacing.xs,
    },
    searchBar: {
        // Local title-filter input. Mirrors the own library's
        // .localSearchBar pill shape so the two screens read the
        // same, minus the `+` button wrapper / row flex — friend
        // libraries have no add affordance, so this stands alone.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        borderWidth: 1,
        height: 44,
        marginHorizontal: spacing.base,
        marginBottom: spacing.md,
    },
    searchInput: {
        flex: 1,
        // padding zeroed: the parent's fixed height owns vertical
        // sizing so the icon and text stay aligned.
        paddingVertical: 0,
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
    // Grid styles mirror the Library tab so a friend's grid looks
    // identical at the same density. Values pulled across verbatim;
    // diverging here would create a subtle inconsistency between
    // "my library" and "their library" at a glance.
    gridContent: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.lg,
        paddingTop: spacing.sm,
    },
    gridCell: {
        position: 'relative',
    },
    gridPoster: {
        borderRadius: radius.sm,
    },
    gridRatingChip: {
        position: 'absolute',
        bottom: spacing.xs,
        left: spacing.xs,
        paddingHorizontal: spacing.xs,
        paddingVertical: 3,
        borderRadius: radius.sm,
        opacity: 0.92,
    },
    gridRatingText: {
        ...typography.caption,
        fontWeight: '600',
    },
});
