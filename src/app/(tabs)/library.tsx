import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import {
    Lock,
    Plus,
    Search as SearchIcon,
    Users,
    X,
} from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import {
    Dimensions,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import { ScreenHeader } from '@/components/screen-header';
import {
    SEARCH_OVERLAY_TOP_OFFSET,
    SearchBarOverlay,
    useSearchBar,
} from '@/components/search-bar';
import { useUnreadCount } from '@/hooks/use-unread-count';
import {
    type LibraryGridCols,
    useLibraryView,
} from '@/lib/library-view';
import { TMDB_GENRE_NAMES } from '@/lib/genres';
import {
    setItemVisibility,
    type ItemVisibility,
} from '@/lib/item-status';
import { formatRatingStars, ratingGlyphs } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import { useLibraryFilters } from '@/lib/use-library-filters';
import { LibraryFilterControls } from '@/components/library-filter-controls';
import { SegmentedControl } from '@/components/segmented-control';
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
    tmdbId: number;
    mediaType: MediaType;
    rating: number | null;
    // items.visibility — 'private' hides this item's activity from
    // friends; drives the per-row privacy toggle.
    visibility: ItemVisibility;
    watchedAt: string | null;
    updatedAt: string;
    createdAt: string;
    title: string;
    posterPath: string | null;
    year: string;
    // Full release_date ('YYYY-MM-DD' or null) retained for the release-date
    // sorts; `year` above is the display slice.
    releaseDate: string | null;
    // Read from the titles row for stage-5 genre / language filters
    // (GIN index on titles.genre_ids exists already). Not rendered by
    // the current library UI; carried on the row so the future filter
    // is a render-side change, not another loader rewrite.
    originalLanguage: string | null;
    genreIds: number[] | null;
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
// SegmentedControl wants an array of {value, label}; precompute at module
// scope so the reference is stable across renders (avoids re-creating
// the array every frame, which would also force a child re-render).
const TAB_OPTIONS: ReadonlyArray<{ value: ItemStatus; label: string }> =
    TABS.map((value) => ({ value, label: TAB_LABELS[value] }));
// "Tap + to add" referenced a Plus icon that's been removed since the
// shared SearchBar took over the header — copy refreshed to point at
// the search bar as the primary add path.
const EMPTY_MESSAGES: Record<ItemStatus, string> = {
    watchlist: 'Your watchlist is empty. Use the search bar above to find something to add.',
    watching: 'Nothing currently watching.',
    watched: 'No watched titles yet.',
};

// Stable empty-array reference for not-yet-loaded tabs, so the derived
// `rows` keeps a constant identity across renders (avoids needless
// re-runs in useLibraryFilters while a tab is still loading).
const NO_ROWS: LibraryRow[] = [];

// One scroll container drives the whole screen (mirrors FriendLibrary):
// data[0] is the sticky filter zone, the rest are list rows or manually
// chunked grid rows — FlatList's numColumns is incompatible with
// stickyHeaderIndices, so the grid chunks itself.
type LibraryListItem =
    | { type: 'filters' }
    | { type: 'listRow'; row: LibraryRow }
    | { type: 'gridRow'; rows: LibraryRow[] };

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

export default function LibraryScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const tabBarInset = useFloatingTabBarInset();
    const { count: unreadCount } = useUnreadCount();

    const [activeTab, setActiveTab] = useState<ItemStatus>('watchlist');
    // Per-tab cache: each status tab's last-loaded rows. A tab stays
    // undefined until its first successful load, so switching to an
    // already-loaded tab renders its cached rows instantly. The focus
    // effect still refetches the active tab in the background
    // (stale-while-revalidate), so the cache refreshes without ever
    // flashing the loader on a revisit.
    const [rowsByTab, setRowsByTab] = useState<
        Partial<Record<ItemStatus, LibraryRow[]>>
    >({});
    const activeRows = rowsByTab[activeTab];
    const hasLoaded = activeRows !== undefined;
    const rows = activeRows ?? NO_ROWS;
    // Apply an in-place update to the ACTIVE tab's cached rows (e.g. an
    // optimistic per-row edit). No-op if the tab hasn't loaded yet.
    const updateActiveRows = useCallback(
        (updater: (rows: LibraryRow[]) => LibraryRow[]) => {
            setRowsByTab((prev) => {
                const current = prev[activeTab];
                if (!current) return prev;
                return { ...prev, [activeTab]: updater(current) };
            });
        },
        [activeTab],
    );
    const [loading, setLoading] = useState(true);
    // Loader only on a genuine first load of a never-seen tab. Once a tab
    // has cached rows, a background revalidation never shows the loader.
    const showLoader = useDeferredLoading(loading && !hasLoaded);
    const [error, setError] = useState<string | null>(null);
    // Per-row privacy writes in flight, keyed by row id, so a row's
    // toggle disables itself without blocking the rest of the list.
    const [visibilityBusyIds, setVisibilityBusyIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { mode, gridCols, setMode, setGridCols } = useLibraryView();
    const screenWidth = Dimensions.get('window').width;
    const insets = useSafeAreaInsets();
    const search = useSearchBar();
    const listRef = useRef<FlatList<LibraryListItem>>(null);
    // Local-filter mode focus state — Home's SearchBarInput tracks
    // focus inside useSearchBar (via overlayVisible) and uses that
    // to render the Cancel button. Library's TextInput is custom
    // (dual-mode local/overlay) so the local-filter mode needs its
    // own focus flag to drive the same Cancel-on-focus affordance.
    // overlayVisible state still owns the add-mode flow; this flag
    // only matters when overlayVisible is false.
    const [localFocused, setLocalFocused] = useState(false);

    // Shared filter / sort / search state + derived visibleRows.
    // Lives in `useLibraryFilters` so the friend library can consume
    // the exact same logic (next stage). Owns: localQuery (title
    // substring), mediaFilter, sortBy, genreFilter, genreStripOpen.
    // Derives: visibleRows (client-side filter + sort, ALWAYS sorted
    // — raw loader order never leaks through), availableGenres.
    // Side effects: tab-default sort reset, stale-genre clear.
    const filters = useLibraryFilters<LibraryRow>(rows, activeTab);

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
                    // re-querying on tab switches. Media filter and sort
                    // now live client-side in useLibraryFilters — the
                    // loader pulls every item for the tab once and the
                    // hook does the filtering / sorting in memory, so
                    // changing media filter or sort is instant (no
                    // refetch). `updated_at DESC` here is just a stable
                    // ingestion order; the hook's comparator runs over
                    // the result regardless, so this ordering never
                    // surfaces to the user.
                    const itemsQuery = supabase
                        .from('items')
                        .select(
                            'id, tmdb_id, media_type, rating, visibility, watched_at, updated_at, created_at',
                        )
                        .eq('user_id', userId)
                        .eq('status', activeTab)
                        .order('updated_at', { ascending: false });

                    const [itemsResult, recsResult] = await Promise.all([
                        itemsQuery,
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

                    // Stage 4: title metadata now comes from the shared
                    // public.titles catalogue in one batched query
                    // instead of N TMDB calls. Stitched in JS by
                    // (media_type, tmdb_id). Missing key → the same
                    // 'Unable to load title' / null-poster fallback the
                    // prior TMDB-failure path produced, so the render
                    // doesn't need a new code path.
                    const titleByKey = await fetchTitlesByItems(itemList);
                    if (!active) return;

                    const combined: LibraryRow[] = itemList.map((row) => {
                        const titleRow = titleByKey.get(
                            `${row.media_type}:${row.tmdb_id}`,
                        );
                        const senderIds =
                            senderIdsByItem.get(`${row.media_type}:${row.tmdb_id}`) ??
                            [];
                        const senders = senderIds
                            .map((id) => senderById.get(id))
                            .filter((s): s is Sender => !!s);
                        return {
                            id: row.id,
                            tmdbId: row.tmdb_id,
                            mediaType: row.media_type as MediaType,
                            rating: row.rating,
                            visibility:
                                row.visibility === 'private'
                                    ? 'private'
                                    : 'friends',
                            watchedAt: row.watched_at,
                            updatedAt: row.updated_at,
                            createdAt: row.created_at,
                            title: titleRow?.title ?? 'Unable to load title',
                            posterPath: titleRow?.poster_path ?? null,
                            year: titleRow?.release_date
                                ? titleRow.release_date.slice(0, 4)
                                : '',
                            releaseDate: titleRow?.release_date ?? null,
                            originalLanguage: titleRow?.original_language ?? null,
                            genreIds: titleRow?.genre_ids ?? null,
                            recAttribution:
                                senders.length > 0
                                    ? { senders, totalCount: senders.length }
                                    : null,
                        };
                    });

                    // `activeTab` here is the value captured when this effect
                    // run was created (the effect re-runs per tab), so it's
                    // the correct cache key for this fetch. The `active` guard
                    // above already bailed if the user switched mid-fetch, so
                    // this only writes for the still-current tab.
                    setRowsByTab((prev) => ({ ...prev, [activeTab]: combined }));
                } catch (err) {
                    if (!active) return;
                    console.error('library fetch failed:', err);
                    setError(
                        err instanceof Error ? err.message : 'Failed to load library',
                    );
                    // Don't clobber the cache: a never-loaded tab stays
                    // undefined (so the error state shows), and a cached tab
                    // keeps its rows (a failed background revalidation leaves
                    // the last-good data on screen).
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

    // Fallback affordance: whenever the user has typed a query, give
    // them a one-tap path to "search to add" the title via the shared
    // SearchBar overlay. Shown as a list footer when the local filter
    // has matches (so the partial-match case — "you have Bakshi's Lord
    // of the Rings but want Fellowship" — still surfaces the add path)
    // AND as the primary action in the empty-state when there are no
    // matches. Tapping pre-populates `search` with the typed query,
    // which fires useSearchBar's debounced TMDB call and flips
    // overlayVisible to true via the `open || query.length > 0` rule.
    function handleAddFallback() {
        const q = filters.localQuery.trim();
        if (q.length === 0) return;
        search.setQuery(q);
    }

    function renderAddFallback() {
        if (filters.localQuery.trim().length === 0) return null;
        return (
            <Pressable
                onPress={handleAddFallback}
                hitSlop={spacing.sm}
                style={({ pressed }) => [
                    styles.addFallbackButton,
                    pressed && { opacity: 0.6 },
                ]}
                accessibilityRole="link"
                accessibilityLabel="Not in your library. Search to add it."
            >
                <Text
                    style={[
                        typography.bodyEmphasis,
                        {
                            color: palette.accent,
                            textAlign: 'center',
                        },
                    ]}
                >
                    Not in your library? Search to add it →
                </Text>
            </Pressable>
        );
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
                            mediaType: item.mediaType,
                            tmdbId: String(item.tmdbId),
                        },
                    })
                }
                style={({ pressed }) => [
                    { width: cellWidth },
                    pressed && { opacity: 0.6 },
                ]}
                accessibilityLabel={item.title}
            >
                {/* Fixed-height poster box: the sender chip anchors to the
                    POSTER's corner, not the (now taller) cell. */}
                <View
                    style={[styles.gridCell, { width: cellWidth, height: cellHeight }]}
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
                </View>
                {showRating && item.rating !== null ? (
                    <Text
                        style={[
                            typography.micro,
                            styles.gridStars,
                            { color: palette.textMuted },
                        ]}
                        numberOfLines={1}
                    >
                        {ratingGlyphs(item.rating)}
                    </Text>
                ) : null}
            </Pressable>
        );
    }

    // Flip one row's privacy. Optimistic: update the row in local state,
    // write via the shared setItemVisibility path, revert that row on
    // failure. Per-row busy flag so toggling one row doesn't lock others.
    async function toggleRowVisibility(row: LibraryRow) {
        if (visibilityBusyIds.has(row.id)) return;
        const next: ItemVisibility =
            row.visibility === 'private' ? 'friends' : 'private';

        updateActiveRows((prev) =>
            prev.map((r) =>
                r.id === row.id ? { ...r, visibility: next } : r,
            ),
        );
        setVisibilityBusyIds((prev) => new Set(prev).add(row.id));
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');
            await setItemVisibility({
                userId,
                tmdbId: row.tmdbId,
                mediaType: row.mediaType,
                visibility: next,
            });
        } catch (err) {
            // Revert the optimistic flip for just this row.
            updateActiveRows((prev) =>
                prev.map((r) =>
                    r.id === row.id
                        ? { ...r, visibility: row.visibility }
                        : r,
                ),
            );
            console.error('visibility toggle failed:', err);
        } finally {
            setVisibilityBusyIds((prev) => {
                const nextSet = new Set(prev);
                nextSet.delete(row.id);
                return nextSet;
            });
        }
    }

    function renderRow({ item }: { item: LibraryRow }) {
        const mediaLabel = item.mediaType === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [item.year, mediaLabel].filter(Boolean).join(' · ');

        const watchedDate = item.watchedAt
            ? new Date(item.watchedAt).toLocaleDateString()
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
                {/* Per-row privacy toggle — its own Pressable so tapping
                    it flips Friends/Private without triggering the row's
                    navigation. Lock (accent) = private; Users (muted) =
                    friends. Unobtrusive: icon-only at the row's right
                    edge. 'private' hides this item's activity from
                    friends; it does not remove the title. */}
                <Pressable
                    onPress={() => toggleRowVisibility(item)}
                    disabled={visibilityBusyIds.has(item.id)}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityState={{ selected: item.visibility === 'private' }}
                    accessibilityLabel={
                        item.visibility === 'private'
                            ? 'Private — only you can see your activity. Tap to let friends see it.'
                            : 'Friends can see your activity. Tap to make private.'
                    }
                    style={({ pressed }) => [
                        styles.privacyToggle,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    {item.visibility === 'private' ? (
                        <Lock
                            color={palette.accent}
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    ) : (
                        <Users
                            color={palette.textMuted}
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    )}
                </Pressable>
            </Pressable>
        );
    }

    // ---- Single-scroll assembly. Header + search scroll away with the
    // content; the filter zone (data[0]) pins at the top via
    // stickyHeaderIndices. Mirrors FriendLibrary — same list shape, same
    // chunked grid, same footer-borne status states — so the two library
    // surfaces stay one pattern, not two collapse variants.

    const listHeader = (
        <>
            {/* Header carries the bell alone; it scrolls away with the
                search row. noTopInset: the screen renders a fixed
                status-bar cap outside the scroll instead. */}
            <ScreenHeader title="Library" unreadCount={unreadCount} noTopInset />
            {/* Search row: local-filter bar + adjacent "+" add affordance.
                The bar dual-modes — wired to localQuery for in-library
                filtering most of the time, swapping to the shared
                useSearchBar's query while the SearchBarOverlay is
                visible so the user has somewhere to type for the add
                flow. The toggle slot at the right is a + when the
                overlay is closed (opens it via handleFocus + focuses
                the bar) and an X when the overlay is open (dismisses).
                The "Not in your library? Search to add it →" fallback
                (renderAddFallback) is rendered as the FlatList footer
                whenever there's a query, AND as the primary action in
                the empty-state when there are no matches — the two
                placements together cover the partial-match case where
                the user has one match but wanted a different version. */}
            <View style={styles.searchRow}>
                <View
                    style={[
                        styles.localSearchBar,
                        { backgroundColor: palette.surface },
                    ]}
                >
                    <SearchIcon
                        color={palette.textMuted}
                        size={20}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <TextInput
                        ref={search.inputRef}
                        value={
                            search.overlayVisible
                                ? search.query
                                : filters.localQuery
                        }
                        onChangeText={
                            search.overlayVisible
                                ? search.setQuery
                                : filters.setLocalQuery
                        }
                        placeholder={
                            search.overlayVisible
                                ? 'Search to add or find anything'
                                : 'Search your library'
                        }
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                        onFocus={() => setLocalFocused(true)}
                        onBlur={() => setLocalFocused(false)}
                        style={[
                            styles.localSearchInput,
                            typography.body,
                            { color: palette.text },
                        ]}
                    />
                    {/* Inline clear-X: visible whenever the active
                        value has text. Clear-only in both modes —
                        keeps the keyboard up + the input focused so
                        the user can re-type fresh. The trailing slot
                        (round X in overlay-mode / "Cancel" text in
                        local-focused mode) is what fully exits and
                        dismisses the keyboard. Two-affordance pattern
                        matching Home's SearchBarInput: X = clear-but-
                        stay, trailing slot = exit. */}
                    {(search.overlayVisible
                        ? search.query
                        : filters.localQuery
                    ).length > 0 ? (
                        <Pressable
                            onPress={() => {
                                if (search.overlayVisible) {
                                    search.setQuery('');
                                } else {
                                    filters.setLocalQuery('');
                                }
                            }}
                            hitSlop={spacing.sm}
                            accessibilityRole="button"
                            accessibilityLabel="Clear search"
                            style={({ pressed }) => [
                                pressed && { opacity: 0.6 },
                            ]}
                        >
                            <X
                                color={palette.textMuted}
                                size={18}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    ) : null}
                </View>
                {/* Trailing slot — intent-aware, 3 states with
                    clear precedence (top wins):
                      1. overlayVisible → round X (cancel add overlay,
                         full dismiss via search.dismiss())
                      2. localFocused   → "Cancel" text (blur input +
                         clear localQuery; matches Home's Cancel)
                      3. resting        → round + (open add overlay)
                    Cancel REPLACES + while locally focused — single
                    intent-aware slot, mirrors the iOS pattern. Tapping
                    Cancel triggers onBlur → localFocused goes false →
                    slot reverts to + on next render. */}
                {search.overlayVisible ? (
                    <Pressable
                        onPress={() => search.dismiss()}
                        hitSlop={spacing.xs}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel search"
                        style={({ pressed }) => [
                            styles.addButton,
                            {
                                backgroundColor: palette.surface,
                            },
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <X
                            color={palette.accent}
                            size={22}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                ) : localFocused ? (
                    <Pressable
                        onPress={() => {
                            filters.setLocalQuery('');
                            search.inputRef.current?.blur();
                        }}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel search"
                        style={({ pressed }) => [
                            styles.cancelButton,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Text
                            style={[typography.body, { color: palette.accent }]}
                        >
                            Cancel
                        </Text>
                    </Pressable>
                ) : (
                    <Pressable
                        onPress={() => {
                            // Open the search overlay AND focus the bar
                            // so the keyboard comes up immediately
                            // (saves the second tap of "now tap the
                            // bar").
                            listRef.current?.scrollToOffset({
                                offset: 0,
                                animated: false,
                            });
                            search.handleFocus();
                            search.inputRef.current?.focus();
                        }}
                        hitSlop={spacing.xs}
                        accessibilityRole="button"
                        accessibilityLabel="Add a title"
                        style={({ pressed }) => [
                            styles.addButton,
                            {
                                backgroundColor: palette.surface,
                            },
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Plus
                            color={palette.accent}
                            size={22}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                )}
            </View>
        </>
    );

    // Sticky zone (data[0]): segmented status picker + filter controls.
    // OPAQUE page-bg fill so rows scroll under it cleanly when pinned.
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
                {/* Filter / sort / genre controls — shared with the
                    friend library (see src/components/library-filter-controls.tsx).
                    State + filtering logic live in useLibraryFilters
                    above; this is pure presentation. Filter + sort
                    are now client-side; the loader fetches every
                    item for the tab once and the hook composes title
                    search + media filter + sort + genre filter in
                    memory, so changes here are instant (no refetch). */}
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
                    // Grid/list toggle at the right of the filter line; a
                    // grid-tap expands it in place to reveal 2/3/4 density.
                    view={{ mode, gridCols, setMode, setGridCols }}
                />
        </View>
    );

    const showError = Boolean(error) && !hasLoaded;
    const bodyItems: LibraryListItem[] = [];
    if (!showLoader && !showError) {
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

    // Status states render as the list FOOTER (below the pinned filter
    // zone) so the sticky assembly never unmounts — switching to an
    // empty/loading tab keeps the chrome stable.
    const statusFooter = showLoader ? (
        <View style={styles.footerLoader}>
            <FullScreenLoader style={styles.loaderTop} />
        </View>
    ) : showError ? (
        <View style={styles.footerStatus}>
            <Text
                style={[typography.body, { color: palette.error }]}
                numberOfLines={3}
            >
                {error}
            </Text>
        </View>
    ) : filters.visibleRows.length === 0 ? (
        <View style={styles.footerStatus}>
            <Text
                style={[
                    typography.body,
                    styles.statusBlockText,
                    { color: palette.textMuted },
                ]}
            >
                {filters.localQuery.trim().length > 0
                    ? rows.length === 0
                        ? 'No matches — nothing in this tab yet.'
                        : 'No matches in your library.'
                    : filters.genreFilter !== null
                      ? `No ${TMDB_GENRE_NAMES.get(filters.genreFilter) ?? 'matching'} titles.`
                      : EMPTY_MESSAGES[activeTab]}
            </Text>
            {renderAddFallback()}
        </View>
    ) : (
        // Non-empty: the add fallback keeps its footer placement (covers
        // the partial-match case where the user wanted a different title).
        renderAddFallback()
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

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {/* Fixed status-bar cap — the header scrolls away inside the
                list below, so this keeps the clock/battery zone on an
                opaque page bg (the sticky filter zone pins right under
                it). */}
            <View style={{ height: insets.top, backgroundColor: palette.bg }} />
            <FlatList
                ref={listRef}
                data={listData}
                keyExtractor={(item) =>
                    item.type === 'filters'
                        ? 'filters'
                        : item.type === 'listRow'
                          ? item.row.id
                          : `gridrow-${item.rows.map((r) => r.id).join('-')}`
                }
                renderItem={renderListItem}
                ListHeaderComponent={listHeader}
                // ListHeaderComponent (header + search) is child 0; the
                // sticky 'filters' item (data[0]) is child 1.
                stickyHeaderIndices={[1]}
                ListFooterComponent={statusFooter}
                contentContainerStyle={{ paddingBottom: tabBarInset }}
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
                            <View
                                style={{ height: GRID_GAP_BY_COLS[gridCols] }}
                            />
                        );
                    }
                    // After the sticky filters row: grid gets a small top
                    // gap (the old gridContent paddingTop); list sits flush.
                    return mode === 'grid' ? (
                        <View style={{ height: spacing.sm }} />
                    ) : null;
                }}
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
    filterZone: {
        // No fill and no divider — the controls sit on the page bg, with
        // no separator between them and the poster grid below. Vertical
        // padding only — see the children's own paddingHorizontal for
        // inset behaviour. paddingTop is tight (spacing.xs) so the gap from
        // the search bar to the segmented row = searchRow.marginBottom (12)
        // + this (4) = 16pt, not the previous 24.
        paddingTop: spacing.xs,
        paddingBottom: spacing.sm,
        gap: spacing.md,
    },
    segmentedRow: {
        // Horizontal inset for the segmented control inside the
        // filter zone, matching the rest of the screen's content
        // gutters (paddingHorizontal: spacing.base elsewhere).
        paddingHorizontal: spacing.base,
    },
    footerStatus: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: spacing.xl,
        paddingBottom: spacing.xxl,
        paddingHorizontal: spacing.xl,
        gap: spacing.md,
    },
    // Fixed-height box so FullScreenLoader's flex:1 has something to
    // fill — as a plain list footer its height would collapse to 0.
    footerLoader: {
        height: 260,
    },
    // Top-anchor the loading eyes just under the filter row where list content
    // appears, instead of centring them in the tall content area below the
    // filter bar (which floated them mid-screen). Overrides FullScreenLoader's
    // default centring — same fix applied on the search overlay.
    loaderTop: {
        justifyContent: 'flex-start',
        paddingTop: spacing.xl,
    },
    statusBlockText: {
        textAlign: 'center',
    },
    addFallbackButton: {
        // Generous padding so the footer rendering sits comfortably
        // below the last list row and reads as a deliberate "you can
        // also add a new title from here" affordance, not a stray link.
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.base,
    },
    searchRow: {
        // Wraps the search bar + adjacent "+" button as one connected
        // row. Horizontal margins live here so the bar's `flex: 1`
        // measures the row's remaining width after the + and gap.
        // marginBottom gives the page-bg air strip below the search
        // and above the surfaceAlt filter zone — without it the zone
        // butts directly against the search and the two read as a
        // single blob. Matches src/app/friends/[handle].tsx > searchBar's
        // marginBottom so the two surfaces stay visually consistent.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
        marginBottom: spacing.md,
    },
    localSearchBar: {
        // Mirrors the shared SearchBar's pill shape so the visual
        // language matches Home, but the input wired here filters the
        // already-loaded library rows in memory rather than firing a
        // TMDB query (unless the overlay is open, in which case the
        // bar dual-modes to drive useSearchBar's query directly).
        //
        // Border deliberately omitted — the surface fill against the
        // page bg is the visual separation; pairing fill + border
        // reads as a generic input pill. The filter zone below uses
        // a different surface (surfaceAlt), so the search and the
        // zone stay visually distinct through tonal contrast alone.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    cancelButton: {
        // Plain text Pressable, sized via horizontal padding to feel
        // tappable without competing visually with the search pill.
        // Mirrors the Home SearchBarInput's cancel button styling.
        paddingHorizontal: spacing.xs,
    },
    addButton: {
        // Circular control sized to match the search bar's pill height
        // so the row reads as a connected pair. Borderless surface fill
        // (matching the now-borderless search bar) — the surface tone
        // against the page bg is the separation, and the accent-coloured
        // icon stroke gives it enough weight without an outline.
        width: 44,
        height: 44,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    localSearchInput: {
        flex: 1,
        // padding zeroed: the parent's fixed height owns vertical
        // sizing so the icon and text stay perfectly aligned.
        paddingVertical: 0,
    },
    bodyInset: {
        paddingHorizontal: spacing.base,
    },
    gridRow: {
        flexDirection: 'row',
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
    privacyToggle: {
        // Icon-only tap target at the row's right edge; padding gives it a
        // comfortable hit area without a visible chrome.
        padding: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
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

    gridCell: {
        position: 'relative',
    },
    gridPoster: {
        borderRadius: radius.sm,
    },
    // Star glyphs under the poster (replaced the on-poster overlay
    // chip). Left-aligned; unrated cells render nothing below the
    // poster — grid rows top-align, so poster rhythm is unchanged.
    gridStars: {
        marginTop: spacing.xxs,
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
