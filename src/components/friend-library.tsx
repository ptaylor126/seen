import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Search as SearchIcon, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import Animated, {
    type useAnimatedScrollHandler,
} from 'react-native-reanimated';

import { LibraryFilterControls } from '@/components/library-filter-controls';
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

// The friend library BODY — the items query, the shared filter/sort/search
// state (useLibraryFilters), the persisted view mode (useLibraryView), the
// local search field, the Watched/Watching/Watchlist SegmentedControl, the
// filter chips (LibraryFilterControls), and the grid/list itself. Behaviour is
// identical to the standalone friend-library route it was lifted from; it just
// no longer resolves the friend or renders a header — the caller passes the
// already-resolved friend in. Returns a single scrolling FlatList (no outer
// wrapper), so the caller owns the surrounding chrome.
//
// The items query fires on mount (keyed on friendId), so a caller that mounts
// this lazily still gets the lazy behaviour.

type ItemStatus = 'watchlist' | 'watching' | 'watched';

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

export function FriendLibrary({
    friendId,
    displayName,
    handle,
    onScroll,
    contentTopInset = 0,
}: {
    friendId: string;
    displayName: string;
    handle: string;
    // Collapse wiring (both optional — standalone use needs neither): the
    // host's reanimated scroll handler, so the friend profile's collapsing
    // header can track this list's offset…
    onScroll?: ReturnType<typeof useAnimatedScrollHandler>;
    // …and extra top padding on the content (the host's IDENTITY_H) so the
    // expanded header has room; the list's own sticky filter zone still pins
    // at the FRAME top, which the host places below its pinned tab bar.
    contentTopInset?: number;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const bottomInset = useBottomInset(spacing.lg);

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

    // ---- Fetch items for the active tab. visibility is filtered both
    // client-side (explicit) and by RLS (defence in depth); RLS is the
    // authoritative check.
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
                    placeholder={`Search ${displayName}'s library`}
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
    // controls. Page-bg fill kept OPAQUE so rows don't show through when stuck.
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
                    ? `No matches in @${handle}'s library.`
                    : filters.genreFilter !== null
                      ? `No ${TMDB_GENRE_NAMES.get(filters.genreFilter) ?? 'matching'} titles.`
                      : emptyMessage(activeTab, displayName)}
            </Text>
        </View>
    ) : null;

    return (
        <Animated.FlatList
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
            onScroll={onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={[
                styles.scrollContent,
                { paddingTop: contentTopInset, paddingBottom: bottomInset },
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
                    return <View style={{ height: GRID_GAP_BY_COLS[gridCols] }} />;
                }
                // After the sticky filters row: grid gets a small top gap
                // (matched old gridContent paddingTop); list sat flush.
                return mode === 'grid' ? (
                    <View style={{ height: spacing.sm }} />
                ) : null;
            }}
        />
    );
}

const styles = StyleSheet.create({
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
        marginBottom: spacing.md,
    },
    searchBar: {
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
        paddingVertical: 0,
    },
    filterZone: {
        // Sits on the page bg (fill applied inline, kept opaque so rows don't
        // show through when stuck). Tight paddingTop (xs): search-to-filter
        // gap = searchRow.marginBottom (12) + this (4) = 16pt.
        paddingTop: spacing.xs,
        paddingBottom: spacing.sm,
        gap: spacing.md,
    },
    segmentedRow: {
        paddingHorizontal: spacing.base,
    },
    scrollContent: {},
    bodyInset: {
        paddingHorizontal: spacing.base,
    },
    gridRow: {
        flexDirection: 'row',
    },
    footerStatus: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: spacing.xxl,
        paddingBottom: spacing.xxl,
        paddingHorizontal: spacing.xl,
        gap: spacing.sm,
    },
    centerText: {
        textAlign: 'center',
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
