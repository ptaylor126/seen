import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Search as SearchIcon, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
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
import { Avatar } from '@/components/avatar';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { LibraryFilterControls } from '@/components/library-filter-controls';
import { ScreenHeader } from '@/components/screen-header';
import { SegmentedControl } from '@/components/segmented-control';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { TMDB_GENRE_NAMES } from '@/lib/genres';
import { type LibraryGridCols, useLibraryView } from '@/lib/library-view';
import { formatRatingStars, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import { useLibraryFilters } from '@/lib/use-library-filters';
import { POSTER_ASPECT } from '@/theme/poster-layout';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type ItemStatus = 'watchlist' | 'watching' | 'watched';

// The friend whose library this is. Normally handed across as route params
// from the profile push (no resolve round-trip); resolved by handle/userId
// only on a cold deep-link where the params are absent.
interface Friend {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

// Mirrors the friend-profile ItemRow shape — the items query and its
// title-stitch come across unchanged from src/app/friends/[handle].tsx.
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
    // Full release_date ('YYYY-MM-DD' or null) for the release-date sorts.
    releaseDate: string | null;
    originalLanguage: string | null;
    genreIds: number[] | null;
}

const TABS: readonly ItemStatus[] = ['watchlist', 'watching', 'watched'] as const;
const TAB_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};
// Stable {value, label} array for the shared SegmentedControl — computed
// once at module scope so the prop reference doesn't change across renders.
const TAB_OPTIONS: ReadonlyArray<{ value: ItemStatus; label: string }> =
    TABS.map((value) => ({ value, label: TAB_LABELS[value] }));

const HEADER_AVATAR_SIZE = 28;
const POSTER_W = 56;
const POSTER_H = 84;
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

// The library body is one FlatList so the filter zone (tabs + filters) can
// stick while the search field scrolls away. Its data is a tagged union: a
// single 'filters' row (sticky), then the body as either one 'listRow' per
// item (list mode) or one 'gridRow' per row-of-cells (grid mode — FlatList's
// numColumns is incompatible with stickyHeaderIndices, so we chunk into rows
// ourselves).
type LibraryListItem =
    | { type: 'filters' }
    | { type: 'listRow'; row: ItemRow }
    | { type: 'gridRow'; rows: ItemRow[] };

// Leading-star variant — "★4.5" reads tighter at small chip sizes than the
// trailing-star "4.5★" used in list rows. Mirrors the Library tab.
function compactRatingStars(rating: number): string {
    return `★${rating / 2}`;
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

export default function FriendLibraryScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    // Pushed screen (edges={['top']}) — pad the list clear of the nav bar.
    const bottomInset = useBottomInset(spacing.lg);

    const {
        handle: rawHandle,
        userId: rawUserId,
        name: rawName,
        avatarUrl: rawAvatar,
    } = useLocalSearchParams<{
        handle: string;
        userId?: string;
        name?: string;
        avatarUrl?: string;
    }>();
    // Handles are stored lowercase (handle column CHECK constraint); coerce
    // the URL param so a capitalized cold link still resolves.
    const handle = (rawHandle ?? '').toLowerCase();
    const targetUserId = rawUserId?.trim() || null;

    // Fast path: the profile pushes here with the friend already in hand, so
    // there's no resolve round-trip and no flash. Cold deep-links (params
    // absent) fall through to the resolution effect below.
    const [friend, setFriend] = useState<Friend | null>(() =>
        targetUserId && rawName
            ? {
                  id: targetUserId,
                  handle,
                  displayName: rawName,
                  avatarUrl: rawAvatar?.trim() ? rawAvatar : null,
              }
            : null,
    );
    const [notFound, setNotFound] = useState(false);
    const showLoader = useDeferredLoading(!friend && !notFound);

    const [activeTab, setActiveTab] = useState<ItemStatus>('watched');
    const [items, setItems] = useState<ItemRow[]>([]);
    const [itemsLoading, setItemsLoading] = useState(false);
    const [itemsError, setItemsError] = useState<string | null>(null);

    // Focus state + ref for the local search field — drives the Cancel-on-
    // focus affordance (mirrors Home's SearchBarInput pattern).
    const localSearchInputRef = useRef<TextInput | null>(null);
    const [localFocused, setLocalFocused] = useState(false);

    // Shared filter / sort / search state — the same hook the own library
    // (src/app/(tabs)/library.tsx) uses, so the screens stay in lockstep.
    const filters = useLibraryFilters<ItemRow>(items, activeTab);

    // Global library view mode (persisted). Switching here updates the same
    // setting the Library tab reads — density (gridCols) is part of it.
    const { mode, gridCols, setMode, setGridCols } = useLibraryView();
    const screenWidth = Dimensions.get('window').width;

    // ---- Resolve the friend only when the params didn't carry them (cold
    // deep-link). No-op on the normal push-from-profile path.
    useEffect(() => {
        if (friend) return;
        if (!handle && !targetUserId) {
            setNotFound(true);
            return;
        }
        let active = true;
        (async () => {
            try {
                const q = supabase
                    .from('profiles')
                    .select('id, display_name, handle, avatar_url');
                const { data, error } = await (
                    targetUserId ? q.eq('id', targetUserId) : q.eq('handle', handle)
                ).maybeSingle();
                if (!active) return;
                if (error || !data) {
                    setNotFound(true);
                    return;
                }
                setFriend({
                    id: data.id,
                    handle: data.handle,
                    displayName: data.display_name,
                    avatarUrl: data.avatar_url,
                });
            } catch (err) {
                if (!active) return;
                console.error('friend library resolve failed:', err);
                setNotFound(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [friend, handle, targetUserId]);

    // ---- Fetch items for the active tab. visibility is filtered both
    // client-side (explicit) and by RLS (defence in depth); RLS is the
    // authoritative check. Query carried across unchanged from the friend
    // profile.
    const friendId = friend?.id ?? null;
    useEffect(() => {
        if (!friendId) return;
        let active = true;
        setItemsLoading(true);
        setItemsError(null);
        (async () => {
            try {
                const { data: rows, error } = await supabase
                    .from('items')
                    .select('id, tmdb_id, media_type, rating, watched_at, updated_at, created_at')
                    .eq('user_id', friendId)
                    .eq('status', activeTab)
                    .eq('visibility', 'friends')
                    .order('updated_at', { ascending: false });
                if (!active) return;
                if (error) throw error;

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
                        releaseDate: titleRow?.release_date ?? null,
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
    }, [friendId, activeTab]);

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

    // ---- Cold-link resolution states (normal push-from-profile skips these).
    if (showLoader) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader showBackButton hideBell />
                <FullScreenLoader />
            </View>
        );
    }
    if (notFound || !friend) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader showBackButton hideBell />
                <View style={styles.fillCenter}>
                    <Text
                        style={[
                            typography.heading,
                            styles.centerText,
                            { color: palette.text },
                        ]}
                    >
                        Library unavailable
                    </Text>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        This library isn&apos;t available.
                    </Text>
                </View>
            </View>
        );
    }

    // Body rows for the single scrolling FlatList. Grid mode is chunked into
    // rows of `gridCols` cells (numColumns can't coexist with the sticky
    // filter row); list mode is one item per row. The 'filters' item is
    // data[0] and sticks (stickyHeaderIndices below). Loading / error / empty
    // render in the footer so the sticky tabs stay visible.
    //
    // `showBody` does NOT gate on itemsLoading: switching tabs refetches (the
    // items query is per-status), and emptying the body mid-fetch would
    // collapse the list to just the sticky header and snap scroll to the top.
    // Instead we keep the previous tab's rows mounted until the new ones
    // arrive (keep-previous-data). Only a genuine first-load with no rows yet
    // shows the spinner (see listFooter).
    const hasRows = filters.visibleRows.length > 0;
    const showBody = !itemsError && hasRows;
    const bodyItems: LibraryListItem[] = [];
    if (showBody) {
        if (mode === 'list') {
            for (const row of filters.visibleRows) {
                bodyItems.push({ type: 'listRow', row });
            }
        } else {
            for (let i = 0; i < filters.visibleRows.length; i += gridCols) {
                bodyItems.push({
                    type: 'gridRow',
                    rows: filters.visibleRows.slice(i, i + gridCols),
                });
            }
        }
    }
    const listData: LibraryListItem[] = [{ type: 'filters' }, ...bodyItems];

    // Local title search — scrolls away above the sticky filter zone.
    // Mirrors the library tab's local-filter bar (X = clear-but-stay,
    // Cancel = exit + dismiss). Wired to the shared hook's localQuery state.
    const searchHeader = (
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
                    value={filters.localQuery}
                    onChangeText={filters.setLocalQuery}
                    placeholder={`Search ${friend.displayName}'s library`}
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
                {filters.localQuery.length > 0 ? (
                    <Pressable
                        onPress={() => filters.setLocalQuery('')}
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
                        filters.setLocalQuery('');
                        localSearchInputRef.current?.blur();
                    }}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel search"
                    style={({ pressed }) => [
                        styles.cancelButton,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Cancel
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );

    // Sticky row (data[0]): segmented status picker + media/sort/genre
    // controls. Pins under the fixed header once the search row scrolls past.
    // Page-bg fill kept OPAQUE so rows don't show through when it's stuck.
    const filterZoneNode = (
        <View style={[styles.filterZone, { backgroundColor: palette.bg }]}>
            <View style={styles.segmentedRow}>
                <SegmentedControl
                    options={TAB_OPTIONS}
                    value={activeTab}
                    onChange={setActiveTab}
                    palette={palette}
                />
            </View>
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
                // Grid/list toggle at the right of the filter row; a grid-tap
                // expands it in place to reveal the 2/3/4 density options.
                view={{ mode, gridCols, setMode, setGridCols }}
            />
        </View>
    );

    function renderListItem({ item }: { item: LibraryListItem }) {
        if (item.type === 'filters') return filterZoneNode;
        if (item.type === 'gridRow') {
            return (
                <View
                    style={[
                        styles.bodyInset,
                        styles.gridRow,
                        { columnGap: GRID_GAP_BY_COLS[gridCols] },
                    ]}
                >
                    {item.rows.map((row) => (
                        <View key={row.id}>{renderGridCell({ item: row })}</View>
                    ))}
                </View>
            );
        }
        return (
            <View style={styles.bodyInset}>{renderRow({ item: item.row })}</View>
        );
    }

    // Loading / error / empty live below the sticky filter row so the tabs
    // stay reachable in every state. Order: error first, then the spinner
    // ONLY on a first load with no rows yet (a tab-switch reload keeps the
    // previous rows mounted and shows no spinner, so scroll is preserved),
    // then the empty copy once a load completes with nothing. Empty copy has
    // three sub-cases, in priority order: typed-search → genre filter →
    // per-tab default.
    const listFooter = itemsError ? (
        <View style={styles.footerStatus}>
            <Text
                style={[
                    typography.body,
                    styles.centerText,
                    { color: palette.error },
                ]}
                numberOfLines={3}
            >
                {itemsError}
            </Text>
        </View>
    ) : itemsLoading && !hasRows ? (
        <View style={styles.footerStatus}>
            <ActivityIndicator color={palette.accent} />
        </View>
    ) : !itemsLoading && !hasRows ? (
        <View style={styles.footerStatus}>
            <Text
                style={[
                    typography.body,
                    styles.centerText,
                    { color: palette.textMuted },
                ]}
            >
                {filters.localQuery.trim().length > 0
                    ? `No matches in @${friend.handle}'s library.`
                    : filters.genreFilter !== null
                      ? `No ${TMDB_GENRE_NAMES.get(filters.genreFilter) ?? 'matching'} titles.`
                      : emptyMessage(activeTab, friend.displayName)}
            </Text>
        </View>
    ) : null;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {/* Option A header — plain page-bg bar (not the profile's plum
                arch, that's the profile's signature). Back chevron + a small
                avatar + "{name}'s library" in full. The grid/list toggle (and
                its density popover) live on the filter line, so the header has
                no right-side controls and the name keeps the whole bar. */}
            <ScreenHeader
                showBackButton
                hideBell
                leading={
                    <View style={styles.headerLeading}>
                        <Avatar
                            avatarUrl={friend.avatarUrl}
                            displayName={friend.displayName}
                            seedId={friend.id}
                            size={HEADER_AVATAR_SIZE}
                        />
                        <Text
                            style={[
                                typography.heading,
                                styles.headerTitle,
                                { color: palette.text },
                            ]}
                            numberOfLines={1}
                        >
                            {`${friend.displayName}'s library`}
                        </Text>
                    </View>
                }
            />

            <FlatList
                data={listData}
                keyExtractor={(item) =>
                    item.type === 'filters'
                        ? 'filters'
                        : item.type === 'listRow'
                          ? item.row.id
                          : `gridrow-${item.rows.map((r) => r.id).join('-')}`
                }
                renderItem={renderListItem}
                ListHeaderComponent={searchHeader}
                // ListHeaderComponent (the search row) is child 0; the sticky
                // 'filters' item (data[0]) is child 1.
                stickyHeaderIndices={[1]}
                ListFooterComponent={listFooter}
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: bottomInset },
                ]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                ItemSeparatorComponent={({
                    leadingItem,
                }: {
                    leadingItem: LibraryListItem;
                }) => {
                    if (leadingItem.type === 'listRow') {
                        return (
                            <View style={styles.bodyInset}>
                                <View
                                    style={[
                                        styles.separator,
                                        { backgroundColor: palette.border },
                                    ]}
                                />
                            </View>
                        );
                    }
                    if (leadingItem.type === 'gridRow') {
                        return (
                            <View style={{ height: GRID_GAP_BY_COLS[gridCols] }} />
                        );
                    }
                    // After the sticky filters row: grid gets a small top gap
                    // (matched old gridContent paddingTop); list sat flush.
                    return mode === 'grid' ? (
                        <View style={{ height: spacing.sm }} />
                    ) : null;
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    headerLeading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    headerTitle: {
        // Flex so a long name truncates cleanly. The header carries no
        // right-side controls now, so the name gets nearly the whole bar.
        flex: 1,
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
    searchRow: {
        // Outer row hosting the search pill + the conditional Cancel sibling.
        // Margins live here (not on the pill) so the pill can flex to fill
        // available width when Cancel appears / disappears.
        //
        // marginTop is sm (8), matching the own Library tab's header→search
        // gap. It arrived as lg (24) when the search bar moved off the friend
        // profile (where it sat far below the overview sections and needed the
        // air); directly under a header it read as dead space.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
        marginBottom: spacing.md,
    },
    searchBar: {
        // Local title-filter input. Mirrors the own library's pill shape,
        // minus the `+` button (friend libraries have no add affordance).
        // Border deliberately omitted — the surface fill against the page bg
        // is the visual separation.
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
        // padding zeroed: the parent's fixed height owns vertical sizing so
        // the icon and text stay aligned.
        paddingVertical: 0,
    },
    filterZone: {
        // No shaded band — the controls sit on the page background (fill
        // applied inline as palette.bg, kept opaque so rows don't show
        // through when this sticky zone is stuck). Matches the Library
        // screen's filter zone, including its tight paddingTop (xs): the
        // search-to-filter gap = searchRow.marginBottom (12) + this (4)
        // = 16pt.
        paddingTop: spacing.xs,
        paddingBottom: spacing.sm,
        gap: spacing.md,
    },
    segmentedRow: {
        paddingHorizontal: spacing.base,
    },
    scrollContent: {
        // Whole-screen FlatList: horizontal insets live on the header/filter/
        // body items, which each manage their own gutters. The bottom cushion
        // is applied inline via useBottomInset (nav-bar clearance).
    },
    bodyInset: {
        // Horizontal gutter for library rows / grid rows + their separators.
        paddingHorizontal: spacing.base,
    },
    gridRow: {
        // One chunked row of grid cells. flex-start so a short last row stays
        // left-aligned (matches the old columnWrapper behaviour).
        flexDirection: 'row',
    },
    footerStatus: {
        // Loading / error / empty message, shown under the sticky filter row.
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: spacing.xxl,
        paddingBottom: spacing.xxl,
        paddingHorizontal: spacing.xl,
        gap: spacing.sm,
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
    // Grid cell styles mirror the Library tab so a friend's grid looks
    // identical at the same density.
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
