import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { LayoutGrid, LayoutList } from 'lucide-react-native';
import { type ReactNode, useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    FlatList,
    Pressable,
    StyleSheet,
    type StyleProp,
    Text,
    useColorScheme,
    View,
    type ViewStyle,
} from 'react-native';
import Animated, {
    FadeIn,
    FadeOut,
    LinearTransition,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
import {
    SEARCH_OVERLAY_TOP_OFFSET,
    SearchBarInput,
    SearchBarOverlay,
    useSearchBar,
} from '@/components/search-bar';
import { useUnreadCount } from '@/hooks/use-unread-count';
import {
    type LibraryGridCols,
    type LibraryMode,
    useLibraryView,
} from '@/lib/library-view';
import { formatRatingStars } from '@/lib/rating';
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
type MediaType = 'movie' | 'tv';

interface LibraryRow {
    id: string;
    tmdb_id: number;
    media_type: MediaType;
    rating: number | null;
    watched_at: string | null;
    updated_at: string;
    title: string;
    posterPath: string | null;
    year: string;
    metaLoaded: boolean;
    // Populated when one or more friends have recommended this title.
    // Senders are deduped; totalCount === senders.length today but kept
    // separate so we can later cap the displayed list.
    recAttribution: {
        senders: {
            userId: string;
            handle: string;
            displayName: string;
            avatarUrl: string | null;
        }[];
        totalCount: number;
    } | null;
}

interface Sender {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
}

function formatRecAttribution(attr: NonNullable<LibraryRow['recAttribution']>): string {
    const names = attr.senders.map((s) => firstName(s.displayName));
    if (attr.totalCount === 1) return `Rec'd by ${names[0]}`;
    if (attr.totalCount === 2) return `Rec'd by ${names[0]} & ${names[1]}`;
    return `Rec'd by ${names[0]} +${attr.totalCount - 1} others`;
}

const TABS: readonly ItemStatus[] = ['watchlist', 'watching', 'watched'] as const;
const TAB_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};
const EMPTY_MESSAGES: Record<ItemStatus, string> = {
    watchlist: 'Your watchlist is empty. Tap + to add something.',
    watching: 'Nothing currently watching.',
    watched: 'No watched titles yet.',
};

const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;

// Grid sizing: gap is wider at low density so the posters don't read as
// crammed at grid-2, tighter at high density so we can fit grid-4 on
// narrow screens. columnGap === rowGap in both cases.
const POSTER_ASPECT = 1.5; // 2:3 poster
const GRID_GAP_BY_COLS: Record<LibraryGridCols, number> = {
    2: spacing.base,
    3: spacing.sm,
    4: spacing.sm,
};

const GRID_AVATAR_SIZE = 20;
const GRID_PLUS_BADGE_HEIGHT = 14;

function getGridCellWidth(cols: LibraryGridCols, screenWidth: number): number {
    const gap = GRID_GAP_BY_COLS[cols];
    const usable = screenWidth - 2 * spacing.base;
    return Math.floor((usable - (cols - 1) * gap) / cols);
}

// N+1 metadata fetch — see prior journal entry for the trade-off. Posters
// cache at the expo-image layer; only the JSON metadata is the real cost.
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

export default function LibraryScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { count: unreadCount } = useUnreadCount();

    const [activeTab, setActiveTab] = useState<ItemStatus>('watchlist');
    const [rows, setRows] = useState<LibraryRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const { mode, gridCols, setMode, setGridCols } = useLibraryView();
    const screenWidth = Dimensions.get('window').width;
    const insets = useSafeAreaInsets();
    // Shared SearchBar — same TMDB-search + add flow used on Home. The
    // old local-substring filter on already-loaded rows is gone; search
    // now reaches the title detail screen where status (watchlist /
    // watching / watched) is set.
    const search = useSearchBar();

    useFocusEffect(
        useCallback(() => {
            let active = true;

            const load = async () => {
                setLoading(true);
                setError(null);
                try {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    const userId = session?.user.id;
                    if (!userId) throw new Error('Not authenticated');

                    // Items for the current tab + every accepted/watched rec
                    // sent to this user run in parallel. The rec set covers
                    // the whole library (not just this tab) because joining
                    // by (tmdb_id, media_type) per item is cheaper than
                    // re-querying on tab switches.
                    const [itemsResult, recsResult] = await Promise.all([
                        supabase
                            .from('items')
                            .select(
                                'id, tmdb_id, media_type, rating, watched_at, updated_at',
                            )
                            .eq('user_id', userId)
                            .eq('status', activeTab)
                            .order('updated_at', { ascending: false }),
                        supabase
                            .from('recommendations')
                            .select('from_user_id, tmdb_id, media_type, sent_at')
                            .eq('to_user_id', userId)
                            // Attribution survives dismissal: if a friend
                            // recommended a title and the user later added
                            // it themselves (after dismissing the rec),
                            // they still get credit as the recommender.
                            // 'pending' stays out — a pending rec means
                            // the show isn't in the library yet, so there's
                            // nothing to attribute it to.
                            .in('status', ['accepted', 'watched', 'dismissed'])
                            .order('sent_at', { ascending: false }),
                    ]);

                    if (itemsResult.error) throw itemsResult.error;
                    if (recsResult.error) throw recsResult.error;
                    if (!active) return;

                    const itemList = itemsResult.data ?? [];
                    const recList = recsResult.data ?? [];

                    // Group senders by (media_type, tmdb_id) and collect the
                    // distinct sender ids we'll need profiles for. Senders
                    // are kept in most-recent-rec-first order via the SQL
                    // sort above, and deduped within each item group (a
                    // sender could appear twice if they re-sent after a
                    // dismiss — rare but cheap to guard).
                    const senderIdsByItem = new Map<string, string[]>();
                    const allSenderIds = new Set<string>();
                    for (const rec of recList) {
                        if (!rec.from_user_id) continue;
                        const key = `${rec.media_type}:${rec.tmdb_id}`;
                        const list = senderIdsByItem.get(key) ?? [];
                        if (!list.includes(rec.from_user_id)) {
                            list.push(rec.from_user_id);
                            senderIdsByItem.set(key, list);
                        }
                        allSenderIds.add(rec.from_user_id);
                    }

                    const profilesResult =
                        allSenderIds.size > 0
                            ? await supabase
                                  .from('profiles')
                                  .select('id, handle, display_name, avatar_url')
                                  .in('id', Array.from(allSenderIds))
                            : { data: [], error: null };

                    if (profilesResult.error) throw profilesResult.error;
                    if (!active) return;

                    const senderById = new Map<string, Sender>(
                        (profilesResult.data ?? []).map((p) => [
                            p.id,
                            {
                                userId: p.id,
                                handle: p.handle,
                                displayName: p.display_name,
                                avatarUrl: p.avatar_url,
                            },
                        ]),
                    );

                    const metaResults = await Promise.allSettled(
                        itemList.map((row) =>
                            fetchItemMeta(row.tmdb_id, row.media_type as MediaType),
                        ),
                    );
                    if (!active) return;

                    const combined: LibraryRow[] = itemList.map((row, i) => {
                        const result = metaResults[i];
                        const meta =
                            result.status === 'fulfilled'
                                ? result.value
                                : {
                                      title: 'Unable to load title',
                                      posterPath: null,
                                      year: '',
                                  };
                        const senderIds =
                            senderIdsByItem.get(`${row.media_type}:${row.tmdb_id}`) ??
                            [];
                        const senders = senderIds
                            .map((id) => senderById.get(id))
                            .filter((s): s is Sender => !!s);
                        return {
                            id: row.id,
                            tmdb_id: row.tmdb_id,
                            media_type: row.media_type as MediaType,
                            rating: row.rating,
                            watched_at: row.watched_at,
                            updated_at: row.updated_at,
                            ...meta,
                            metaLoaded: result.status === 'fulfilled',
                            recAttribution:
                                senders.length > 0
                                    ? { senders, totalCount: senders.length }
                                    : null,
                        };
                    });

                    setRows(combined);
                } catch (err) {
                    if (!active) return;
                    console.error('library fetch failed:', err);
                    setError(
                        err instanceof Error ? err.message : 'Failed to load library',
                    );
                    setRows([]);
                } finally {
                    if (active) setLoading(false);
                }
            };

            load();

            return () => {
                active = false;
            };
        }, [activeTab]),
    );

    // Leading-star variant for grid chips — "★4.5" reads tighter at
    // small sizes than the trailing-star "4.5★" used in list rows.
    function compactRatingStars(rating: number): string {
        return `★${rating / 2}`;
    }

    function renderGridCell({ item }: { item: LibraryRow }) {
        const cellWidth = getGridCellWidth(gridCols, screenWidth);
        const cellHeight = Math.floor(cellWidth * POSTER_ASPECT);
        const showRating =
            activeTab === 'watched' && item.rating !== null;
        const firstSender = item.recAttribution?.senders[0] ?? null;
        const extraSenders =
            item.recAttribution && item.recAttribution.totalCount > 1
                ? item.recAttribution.totalCount - 1
                : 0;

        return (
            <Pressable
                onPress={() =>
                    router.push({
                        pathname: '/title/[mediaType]/[tmdbId]',
                        params: {
                            mediaType: item.media_type,
                            tmdbId: String(item.tmdb_id),
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
                        style={[styles.gridPoster, { width: cellWidth, height: cellHeight }]}
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

                {firstSender ? (
                    <View
                        style={[styles.gridSenderChip, { borderColor: palette.bg }]}
                    >
                        <Avatar
                            avatarUrl={firstSender.avatarUrl}
                            displayName={firstSender.displayName}
                            seedId={firstSender.userId}
                            size={GRID_AVATAR_SIZE}
                        />
                        {extraSenders > 0 ? (
                            <View
                                style={[
                                    styles.gridPlusBadge,
                                    {
                                        backgroundColor: palette.accent,
                                        borderColor: palette.bg,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.gridPlusBadgeText,
                                        { color: palette.textInverse },
                                    ]}
                                >
                                    +{extraSenders}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                ) : null}
            </Pressable>
        );
    }

    function renderRow({ item }: { item: LibraryRow }) {
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [item.year, mediaLabel].filter(Boolean).join(' · ');

        const watchedDate = item.watched_at
            ? new Date(item.watched_at).toLocaleDateString()
            : '';
        const ratingDisplay =
            item.rating !== null ? formatRatingStars(item.rating) : '';
        const watchedLine = [ratingDisplay, watchedDate].filter(Boolean).join(' · ');
        const showWatchedLine = activeTab === 'watched' && watchedLine.length > 0;

        return (
            <Pressable
                onPress={() =>
                    router.push({
                        pathname: '/title/[mediaType]/[tmdbId]',
                        params: {
                            mediaType: item.media_type,
                            tmdbId: String(item.tmdb_id),
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
                        style={[styles.poster, { backgroundColor: palette.surfaceAlt }]}
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
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            {metaLine}
                        </Text>
                    ) : null}
                    {item.recAttribution ? (
                        <View style={styles.recAttributionRow}>
                            <Avatar
                                avatarUrl={item.recAttribution.senders[0]?.avatarUrl ?? null}
                                displayName={
                                    item.recAttribution.senders[0]?.displayName ?? '?'
                                }
                                seedId={item.recAttribution.senders[0]?.userId ?? item.id}
                                size={16}
                            />
                            <Text
                                style={[
                                    typography.caption,
                                    styles.recAttributionText,
                                    { color: palette.textMuted },
                                ]}
                                numberOfLines={1}
                            >
                                {formatRecAttribution(item.recAttribution)}
                            </Text>
                        </View>
                    ) : null}
                    {showWatchedLine ? (
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            {watchedLine}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader
                title="Library"
                unreadCount={unreadCount}
                rightActions={
                    <ViewControls
                        mode={mode}
                        gridCols={gridCols}
                        onModeChange={setMode}
                        onGridColsChange={setGridCols}
                        palette={palette}
                    />
                }
            />

            <SearchBarInput state={search} />

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

            {loading ? (
                <View style={styles.statusBlock}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : error ? (
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.error }]}
                        numberOfLines={3}
                    >
                        {error}
                    </Text>
                </View>
            ) : rows.length === 0 ? (
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={3}
                    >
                        {EMPTY_MESSAGES[activeTab]}
                    </Text>
                </View>
            ) : mode === 'list' ? (
                <FlatList
                    key="list"
                    data={rows}
                    keyExtractor={(item) => item.id}
                    renderItem={renderRow}
                    contentContainerStyle={styles.listContent}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    ItemSeparatorComponent={() => (
                        <View
                            style={[styles.separator, { backgroundColor: palette.border }]}
                        />
                    )}
                />
            ) : (
                // FlatList can't change numColumns in place — key includes
                // the column count so density changes trigger a clean
                // unmount + remount.
                <FlatList
                    key={`grid-${gridCols}`}
                    data={rows}
                    keyExtractor={(item) => item.id}
                    renderItem={renderGridCell}
                    numColumns={gridCols}
                    contentContainerStyle={styles.gridContent}
                    columnWrapperStyle={{
                        columnGap: GRID_GAP_BY_COLS[gridCols],
                    }}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    ItemSeparatorComponent={() => (
                        <View style={{ height: GRID_GAP_BY_COLS[gridCols] }} />
                    )}
                />
            )}
            {search.overlayVisible && (
                <SearchBarOverlay
                    state={search}
                    top={insets.top + SEARCH_OVERLAY_TOP_OFFSET}
                />
            )}
        </View>
    );
}

type Palette = ReturnType<typeof getPalette>;

// Cell shared between the two control types in the cluster. Both
// variants keep `borderWidth: 1.5` and the same `minHeight` so toggle
// and density cells sit level in the row regardless of which active
// treatment they carry.
//   - `variant: 'fill'`: active = solid accent fill, inactive = no
//     visible chrome. Border is always transparent.
//   - `variant: 'stroke'`: active = coral outline, inactive = no
//     visible chrome. Background is always transparent.
// Caller passes the content color (icon/text) to match.
function ViewControlsCell({
    active,
    variant,
    onPress,
    palette,
    accessibilityLabel,
    cellStyle,
    children,
}: {
    active: boolean;
    variant: 'fill' | 'stroke';
    onPress: () => void;
    palette: Palette;
    accessibilityLabel: string;
    cellStyle?: StyleProp<ViewStyle>;
    children: ReactNode;
}) {
    const variantStyle =
        variant === 'fill'
            ? {
                  backgroundColor: active ? palette.accent : 'transparent',
                  borderColor: 'transparent',
              }
            : {
                  backgroundColor: 'transparent',
                  borderColor: active ? palette.accent : 'transparent',
              };
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.xs}
            style={({ pressed }) => [
                styles.controlsCell,
                cellStyle,
                variantStyle,
                pressed && { opacity: 0.6 },
            ]}
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
        >
            {children}
        </Pressable>
    );
}

function ViewControls({
    mode,
    gridCols,
    onModeChange,
    onGridColsChange,
    palette,
}: {
    mode: LibraryMode;
    gridCols: LibraryGridCols;
    onModeChange: (next: LibraryMode) => void;
    onGridColsChange: (next: LibraryGridCols) => void;
    palette: Palette;
}) {
    const densityOptions: LibraryGridCols[] = [2, 3, 4];
    return (
        // LinearTransition animates the container's width on density
        // mount/unmount so the toggle doesn't pop sideways. Reanimated
        // is used here rather than LayoutAnimation because the latter
        // silently no-ops for mount/unmount on the New Architecture
        // (Fabric, which Expo SDK 54 turns on by default) — that's why
        // the previous LayoutAnimation attempt was invisible.
        <Animated.View
            layout={LinearTransition.duration(180)}
            style={[styles.viewControls, { backgroundColor: palette.surfaceAlt }]}
        >
            <View style={styles.toggleGroup}>
                <ViewControlsCell
                    active={mode === 'list'}
                    variant="fill"
                    onPress={() => onModeChange('list')}
                    palette={palette}
                    accessibilityLabel="List view"
                >
                    <LayoutList
                        color={
                            mode === 'list'
                                ? palette.textInverse
                                : palette.text
                        }
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </ViewControlsCell>
                <ViewControlsCell
                    active={mode === 'grid'}
                    variant="fill"
                    onPress={() => onModeChange('grid')}
                    palette={palette}
                    accessibilityLabel="Grid view"
                >
                    <LayoutGrid
                        color={
                            mode === 'grid'
                                ? palette.textInverse
                                : palette.text
                        }
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </ViewControlsCell>
            </View>
            {mode === 'grid' ? (
                // Density group fades in/out as one cohesive unit so the
                // three numbers read as a single control appearing,
                // rather than three staggered cells popping in.
                <Animated.View
                    style={styles.densityGroup}
                    entering={FadeIn.duration(180)}
                    exiting={FadeOut.duration(140)}
                >
                    {densityOptions.map((opt) => {
                        const isActive = gridCols === opt;
                        return (
                            <ViewControlsCell
                                key={opt}
                                active={isActive}
                                variant="stroke"
                                onPress={() => onGridColsChange(opt)}
                                palette={palette}
                                accessibilityLabel={`${opt} columns`}
                                cellStyle={styles.densityCell}
                            >
                                <Text
                                    style={[
                                        styles.controlsNumber,
                                        {
                                            color: isActive
                                                ? palette.accent
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {opt}
                                </Text>
                            </ViewControlsCell>
                        );
                    })}
                </Animated.View>
            ) : null}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
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
    statusBlock: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
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
        width: POSTER_WIDTH,
        height: POSTER_HEIGHT,
        borderRadius: radius.sm,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: POSTER_WIDTH + spacing.md,
    },
    recAttributionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    recAttributionText: {
        flex: 1,
    },
    viewControls: {
        // Single shared container behind the whole list/grid + density
        // cluster so the controls read as one connected unit. 2pt
        // padding gives the cells a small breath against the rounded
        // outer edge. Gap is the visible separation between the toggle
        // group and the density group when both are present.
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: radius.sm,
        padding: 2,
        gap: spacing.xs,
    },
    toggleGroup: {
        // Tight pair — list and grid are two states of one decision, so
        // they sit flush together with just a hairline of padding.
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    densityGroup: {
        // Wider gap so the three numeric options read as distinct
        // discrete buttons, not a single block.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    controlsCell: {
        // Same height in every variant so the filled toggle and the
        // stroked numbers sit perfectly level in the row. borderWidth
        // is always present (transparent when inactive in the stroke
        // variant, always transparent in the fill variant) to keep
        // layout stable as selection moves.
        minWidth: 28,
        minHeight: 26,
        paddingHorizontal: spacing.xs,
        paddingVertical: 2,
        borderRadius: radius.sm - 2,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    densityCell: {
        // Extra horizontal breathing room so the single-digit number
        // doesn't read as cramped inside its border.
        paddingHorizontal: spacing.sm,
    },
    controlsNumber: {
        // Slightly smaller than the previous 14pt / 600 — reads as a
        // label rather than competing with the toggle icons for weight.
        fontSize: 12,
        fontWeight: '700',
        lineHeight: 16,
    },
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
        // Height tuned to match the sender chip's outer height: text
        // lineHeight (18) + 2 × paddingVertical (3) = 24pt, same as the
        // sender chip's 20pt avatar + 2 × 2pt border. Both anchored at
        // bottom: spacing.xs so they sit on identical baselines, with
        // identical tops — mirrored left / right corners.
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
    gridSenderChip: {
        // Inset to match the rating chip on the opposite corner — same
        // vertical baseline, mirrored horizontally. Kept the 2pt cream
        // border so the chip still reads as distinct from the poster.
        position: 'absolute',
        bottom: spacing.xs,
        right: spacing.xs,
        borderRadius: GRID_AVATAR_SIZE / 2 + 2,
        borderWidth: 2,
        overflow: 'visible',
    },
    gridPlusBadge: {
        // With the chip inset 4pt from the poster edge, a -7 right
        // offset would poke 3pt past the poster bound. -2 keeps the
        // badge attached to the avatar's top-right corner while
        // staying 2pt inside the poster.
        position: 'absolute',
        top: -4,
        right: -2,
        minWidth: GRID_PLUS_BADGE_HEIGHT,
        height: GRID_PLUS_BADGE_HEIGHT,
        paddingHorizontal: 3,
        borderRadius: GRID_PLUS_BADGE_HEIGHT / 2,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    gridPlusBadgeText: {
        fontSize: 9,
        fontWeight: '700',
    },
});
