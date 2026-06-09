import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import {
    ArrowDownUp,
    Plus,
    Search as SearchIcon,
    X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    FlatList,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
import {
    SEARCH_OVERLAY_TOP_OFFSET,
    SearchBarOverlay,
    useSearchBar,
} from '@/components/search-bar';
import { ViewControls } from '@/components/view-controls';
import { useUnreadCount } from '@/hooks/use-unread-count';
import {
    type LibraryGridCols,
    useLibraryView,
} from '@/lib/library-view';
import { TMDB_GENRE_NAMES } from '@/lib/genres';
import { formatRatingStars } from '@/lib/rating';
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
// "Tap + to add" referenced a Plus icon that's been removed since the
// shared SearchBar took over the header — copy refreshed to point at
// the search bar as the primary add path.
const EMPTY_MESSAGES: Record<ItemStatus, string> = {
    watchlist: 'Your watchlist is empty. Use the search bar above to find something to add.',
    watching: 'Nothing currently watching.',
    watched: 'No watched titles yet.',
};

type MediaFilter = 'all' | 'movie' | 'tv';
const MEDIA_FILTERS: readonly MediaFilter[] = ['all', 'movie', 'tv'] as const;
const MEDIA_FILTER_LABELS: Record<MediaFilter, string> = {
    all: 'All',
    movie: 'Movies',
    tv: 'TV',
};

type SortOption = 'dateWatched' | 'dateAdded' | 'rating';
const SORT_LABELS: Record<SortOption, string> = {
    dateWatched: 'Date watched',
    dateAdded: 'Date added',
    rating: 'Rating',
};
// Map sort option → server column. NULLS LAST is applied uniformly so
// unrated / unwatched rows don't bubble to the top when the sort field
// doesn't apply to them (e.g. rating on Watchlist).
const SORT_COLUMNS: Record<SortOption, string> = {
    dateWatched: 'watched_at',
    dateAdded: 'created_at',
    rating: 'rating',
};
// Tab defaults: Watchlist / Watching emphasise recency of intent (when
// did I add this); Watched emphasises recency of viewing.
const DEFAULT_SORT_BY_TAB: Record<ItemStatus, SortOption> = {
    watchlist: 'dateAdded',
    watching: 'dateAdded',
    watched: 'dateWatched',
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
    // Library search is a LOCAL filter on the rows already fetched for
    // the active tab — typing narrows in-memory by title substring,
    // instant and round-trip-free. The shared `useSearchBar` instance
    // below stays mounted but is wired ONLY to the TMDB-fallback
    // affordance (see the "no local matches" branch), not to the local
    // input. Two-state design: localQuery is the primary, useSearchBar
    // is the escape hatch.
    const [localQuery, setLocalQuery] = useState('');
    const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
    const [sortBy, setSortBy] = useState<SortOption>(
        DEFAULT_SORT_BY_TAB.watchlist,
    );
    // Genre filter — client-side, single-select, applied on already-
    // loaded rows. `null` = no filter. Composes with localQuery (title
    // search) above, AND with the server-side media filter + sort. A
    // row with empty/missing genre_ids naturally falls out when a
    // genre is selected.
    const [genreFilter, setGenreFilter] = useState<number | null>(null);
    // Whether the genre chip strip is revealed. The "Genre" pill in
    // the controls row toggles this; selecting / clearing a chip also
    // collapses the strip (the active state surfaces through the
    // pill's label + accent fill, so the strip's job is done once a
    // choice is made and re-opening is one tap away).
    const [genreStripOpen, setGenreStripOpen] = useState(false);
    const search = useSearchBar();

    // On tab switch, snap sort back to that tab's default. Keeps the
    // user out of the "rating-desc on Watchlist sorts by NULL" trap and
    // matches the per-tab default reasoning.
    useEffect(() => {
        setSortBy(DEFAULT_SORT_BY_TAB[activeTab]);
    }, [activeTab]);

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
                    // Compose the items query incrementally so the media
                    // filter is a no-op when 'all' is selected (don't send
                    // an unused .eq), and the sort column comes from the
                    // sortBy state. nullsFirst: false keeps rows with NULL
                    // in the sort column at the bottom — e.g. unwatched
                    // items don't bubble to the top when sorting by
                    // watched_at on the Watchlist tab.
                    let itemsQuery = supabase
                        .from('items')
                        .select(
                            'id, tmdb_id, media_type, rating, watched_at, updated_at',
                        )
                        .eq('user_id', userId)
                        .eq('status', activeTab);
                    if (mediaFilter !== 'all') {
                        itemsQuery = itemsQuery.eq('media_type', mediaFilter);
                    }
                    itemsQuery = itemsQuery.order(SORT_COLUMNS[sortBy], {
                        ascending: false,
                        nullsFirst: false,
                    });

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
                            tmdb_id: row.tmdb_id,
                            media_type: row.media_type as MediaType,
                            rating: row.rating,
                            watched_at: row.watched_at,
                            updated_at: row.updated_at,
                            title: titleRow?.title ?? 'Unable to load title',
                            posterPath: titleRow?.poster_path ?? null,
                            year: titleRow?.release_date
                                ? titleRow.release_date.slice(0, 4)
                                : '',
                            originalLanguage: titleRow?.original_language ?? null,
                            genreIds: titleRow?.genre_ids ?? null,
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
        }, [activeTab, mediaFilter, sortBy]),
    );

    // Client-side title substring + genre filter on the loaded rows.
    // The media filter and sort live server-side (the query refetches
    // on those state changes); the title filter and genre filter are
    // in-memory so typing / genre selection feels instant for 600+-row
    // libraries. A row with empty/missing genre_ids naturally fails
    // the includes check when a genre is selected — that's the
    // intended behaviour (unreleased / catalogue-incomplete titles
    // fall out of a genre filter, surface again when none is active).
    const filteredRows = useMemo(() => {
        const q = localQuery.trim().toLowerCase();
        return rows.filter((r) => {
            if (q && !r.title.toLowerCase().includes(q)) return false;
            if (genreFilter !== null) {
                if (!r.genreIds || !r.genreIds.includes(genreFilter)) {
                    return false;
                }
            }
            return true;
        });
    }, [rows, localQuery, genreFilter]);

    // Genre options to surface in the picker — only the genres
    // actually present in the user's loaded library, deduped, sorted
    // alphabetically by display name. Re-derives when the loaded set
    // changes (tab swap, media-filter swap, sort swap, fresh focus).
    // Map.get falls back to `#${id}` for the (unlikely) case TMDB
    // adds a new genre id before this constant is updated — keeps the
    // picker functional without crashing.
    const availableGenres = useMemo(() => {
        const ids = new Set<number>();
        for (const row of rows) {
            if (row.genreIds) {
                for (const id of row.genreIds) ids.add(id);
            }
        }
        return Array.from(ids)
            .map((id) => ({
                id,
                name: TMDB_GENRE_NAMES.get(id) ?? `#${id}`,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [rows]);

    // Drop a stale genre selection when the loaded rows no longer
    // contain it — e.g. swap from 'all' → 'tv' media filter, the row
    // set changes, and the previously-selected genre may not be in
    // any of the new rows. Without this the UI shows "No {genre}
    // titles" with no obvious way out other than tapping the chip.
    useEffect(() => {
        if (genreFilter === null) return;
        const stillPresent = availableGenres.some(
            (g) => g.id === genreFilter,
        );
        if (!stillPresent) setGenreFilter(null);
    }, [availableGenres, genreFilter]);

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
        const q = localQuery.trim();
        if (q.length === 0) return;
        search.setQuery(q);
    }

    function renderAddFallback() {
        if (localQuery.trim().length === 0) return null;
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

    function openSortMenu() {
        Alert.alert('Sort by', undefined, [
            ...(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => ({
                text: SORT_LABELS[opt] + (sortBy === opt ? '  ✓' : ''),
                onPress: () => setSortBy(opt),
            })),
            { text: 'Cancel', style: 'cancel' as const },
        ]);
    }

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
                        ref={search.inputRef}
                        value={
                            search.overlayVisible ? search.query : localQuery
                        }
                        onChangeText={
                            search.overlayVisible
                                ? search.setQuery
                                : setLocalQuery
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
                        style={[
                            styles.localSearchInput,
                            typography.body,
                            { color: palette.text },
                        ]}
                    />
                </View>
                <Pressable
                    onPress={() => {
                        if (search.overlayVisible) {
                            // Toggle slot is in X mode — dismiss the
                            // search overlay. The bar dual-modes back
                            // to local-filter via overlayVisible going
                            // false, and the slot reverts to Plus on
                            // the next render.
                            search.dismiss();
                        } else {
                            // Toggle slot is in + mode — open the
                            // search overlay and focus the bar so the
                            // keyboard comes up immediately (saves the
                            // second tap of "now tap the bar").
                            search.handleFocus();
                            search.inputRef.current?.focus();
                        }
                    }}
                    hitSlop={spacing.xs}
                    accessibilityRole="button"
                    accessibilityLabel={
                        search.overlayVisible
                            ? 'Cancel search'
                            : 'Add a title'
                    }
                    style={({ pressed }) => [
                        styles.addButton,
                        {
                            backgroundColor: palette.surface,
                            borderColor: palette.border,
                        },
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    {search.overlayVisible ? (
                        <X
                            color={palette.accent}
                            size={22}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    ) : (
                        <Plus
                            color={palette.accent}
                            size={22}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    )}
                </Pressable>
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

            {/* Filter (media type, segmented) + Sort (menu via Alert).
                Filter and sort both refetch the items query (server-
                side narrowing/ordering). Local search applies on top of
                whatever this row produces. */}
            <View style={styles.controlsRow}>
                <View style={styles.mediaFilterGroup}>
                    {MEDIA_FILTERS.map((opt) => {
                        const isActive = mediaFilter === opt;
                        return (
                            <Pressable
                                key={opt}
                                onPress={() => setMediaFilter(opt)}
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityLabel={MEDIA_FILTER_LABELS[opt]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isActive }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {MEDIA_FILTER_LABELS[opt]}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
                <View style={styles.rightControls}>
                    {/* Genre toggle pill — reveals/collapses the
                        chip strip below. Default state: outlined,
                        label = "Genre". Active state (genreFilter is
                        set): accent-filled, label = the selected
                        genre's name. The strip's visibility is purely
                        a UI affordance — collapsed-with-active-filter
                        is a valid state because the accent pill
                        carries the "filtering by Comedy" signal on
                        its own. Active visuals are derived from one
                        boolean (`isGenreActive`) so bg / border /
                        text colour / label can't drift out of sync. */}
                    {(() => {
                        const isGenreActive = genreFilter !== null;
                        const activeGenreLabel = isGenreActive
                            ? TMDB_GENRE_NAMES.get(genreFilter) ??
                              `#${genreFilter}`
                            : null;
                        return (
                            <Pressable
                                onPress={() =>
                                    setGenreStripOpen((open) => !open)
                                }
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isGenreActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isGenreActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    isGenreActive
                                        ? `Genre filter: ${activeGenreLabel}. Tap to ${genreStripOpen ? 'hide' : 'show'} options.`
                                        : `${genreStripOpen ? 'Hide' : 'Show'} genre options`
                                }
                                accessibilityState={{
                                    selected: isGenreActive,
                                    expanded: genreStripOpen,
                                }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isGenreActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {isGenreActive
                                        ? activeGenreLabel
                                        : 'Genre'}
                                </Text>
                            </Pressable>
                        );
                    })()}
                    <Pressable
                        onPress={openSortMenu}
                        hitSlop={spacing.xs}
                        style={({ pressed }) => [
                            styles.sortButton,
                            pressed && { opacity: 0.6 },
                        ]}
                        accessibilityLabel={`Sort by ${SORT_LABELS[sortBy]}`}
                        accessibilityRole="button"
                    >
                        <ArrowDownUp
                            color={palette.text}
                            size={14}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                        <Text
                            style={[
                                typography.caption,
                                styles.sortButtonText,
                                { color: palette.text },
                            ]}
                        >
                            {SORT_LABELS[sortBy]}
                        </Text>
                    </Pressable>
                </View>
            </View>

            {/* Genre chip strip — revealed by the Genre pill above.
                Horizontal scroll, full width. Populated from
                availableGenres (only genres present in the loaded
                library, sorted alphabetically). Same chip styling as
                the media filter pills so the two rows read as one
                visual family. Tap an inactive chip to filter; tap
                the active chip to clear. Either tap also collapses
                the strip — the active state is preserved on the
                Genre pill above. */}
            {genreStripOpen && availableGenres.length > 0 ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.genreScrollRow}
                    contentContainerStyle={styles.genreScrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* "All genres" sentinel chip — first in the
                        strip. Active (accent) when no genre filter is
                        set; selecting it clears the filter and
                        collapses the strip, same shape as tapping the
                        currently-active genre chip. Deliberately
                        labelled "All genres" not "All" to avoid
                        colliding with the media-filter row's "All"
                        (All / Movies / TV) directly above. The
                        controls-row Genre toggle pill stays in its
                        default outlined "Genre" state when this is
                        active — that pill only flips to accent when
                        a SPECIFIC genre is selected. */}
                    {(() => {
                        const isAllActive = genreFilter === null;
                        return (
                            <Pressable
                                key="__all_genres"
                                onPress={() => {
                                    setGenreFilter(null);
                                    setGenreStripOpen(false);
                                }}
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isAllActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isAllActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    isAllActive
                                        ? 'All genres (current)'
                                        : 'Show all genres'
                                }
                                accessibilityState={{ selected: isAllActive }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isAllActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    All genres
                                </Text>
                            </Pressable>
                        );
                    })()}
                    {availableGenres.map((g) => {
                        const isActive = genreFilter === g.id;
                        return (
                            <Pressable
                                key={g.id}
                                onPress={() => {
                                    setGenreFilter(isActive ? null : g.id);
                                    setGenreStripOpen(false);
                                }}
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    isActive
                                        ? `Clear ${g.name} filter`
                                        : `Filter by ${g.name}`
                                }
                                accessibilityState={{ selected: isActive }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {g.name}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            ) : null}

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
            ) : filteredRows.length === 0 ? (
                // Two sub-cases share this branch:
                //   1. No query → static empty copy for the tab, vertically
                //      centered (keyboard isn't up — the user hasn't
                //      started typing).
                //   2. Query present → "no matches" copy + the Add
                //      fallback, top-aligned because the keyboard is up
                //      mid-search and a centered block + fallback would
                //      sit behind it. Top-alignment keeps the fallback
                //      visible and tappable without forcing the user to
                //      dismiss the keyboard to reach it.
                <View
                    style={[
                        styles.statusBlock,
                        localQuery.trim().length > 0 &&
                            styles.statusBlockSearching,
                    ]}
                >
                    <Text
                        style={[
                            typography.body,
                            styles.statusBlockText,
                            { color: palette.textMuted },
                        ]}
                    >
                        {localQuery.trim().length > 0
                            ? rows.length === 0
                                ? 'No matches — nothing in this tab yet.'
                                : 'No matches in your library.'
                            : genreFilter !== null
                              ? `No ${TMDB_GENRE_NAMES.get(genreFilter) ?? 'matching'} titles.`
                              : EMPTY_MESSAGES[activeTab]}
                    </Text>
                    {renderAddFallback()}
                </View>
            ) : mode === 'list' ? (
                <FlatList
                    key="list"
                    data={filteredRows}
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
                    // Footer surfaces the Add fallback whenever there's
                    // an active query — closes the partial-match gap
                    // where "lord" matches one library item but the
                    // user wanted a different Lord of the Rings.
                    ListFooterComponent={renderAddFallback()}
                />
            ) : (
                // FlatList can't change numColumns in place — key includes
                // the column count so density changes trigger a clean
                // unmount + remount.
                <FlatList
                    key={`grid-${gridCols}`}
                    data={filteredRows}
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
                    ListFooterComponent={renderAddFallback()}
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
        gap: spacing.md,
    },
    statusBlockSearching: {
        // Override the centering of the default statusBlock when the
        // user is actively searching: the keyboard is up, and a
        // centered block would put the empty-state copy + the Add
        // fallback link directly behind it. Top-aligned with a
        // generous-but-bounded top padding so the content sits just
        // below the controls row, well clear of any keyboard. Same
        // style works portrait/landscape (app is portrait-locked, but
        // robust regardless).
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
    },
    localSearchBar: {
        // Mirrors the shared SearchBar's pill shape so the visual
        // language matches Home, but the input wired here filters the
        // already-loaded library rows in memory rather than firing a
        // TMDB query (unless the overlay is open, in which case the
        // bar dual-modes to drive useSearchBar's query directly).
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        borderWidth: 1,
        height: 44,
    },
    addButton: {
        // Circular control sized to match the search bar's pill height
        // so the row reads as a connected pair. Outlined (surface fill
        // + hairline border) rather than accent-filled so it doesn't
        // upstage the primary "search your library" affordance — the
        // accent-coloured icon stroke gives it enough weight.
        width: 44,
        height: 44,
        borderRadius: radius.full,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    localSearchInput: {
        flex: 1,
        // padding zeroed: the parent's fixed height owns vertical
        // sizing so the icon and text stay perfectly aligned.
        paddingVertical: 0,
    },
    controlsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.sm,
        gap: spacing.sm,
    },
    mediaFilterGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    mediaFilterPill: {
        // Outlined pill when inactive, filled accent when active.
        // borderWidth always present (transparent → accent) so the
        // layout doesn't jitter as the selection moves.
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
        borderWidth: 1,
    },
    mediaFilterText: {
        fontWeight: '600',
    },
    rightControls: {
        // Sub-group on the right of controlsRow holding the Genre
        // toggle + Sort button. Sits opposite the media filter pills
        // on the left side of the parent's space-between.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    genreScrollRow: {
        // Horizontal chip strip below controlsRow when revealed.
        //
        // `flexShrink: 0` + explicit `height` are load-bearing: without
        // them the FlatList below (which has no `flex: 1` and instead
        // uses its intrinsic content height) competes for vertical
        // space in the parent column-flex. On a near-empty tab the
        // FlatList's intrinsic height is small and there's slack for
        // the chip strip to keep its natural ~36px; on a full tab the
        // FlatList wants the whole screen, the column-flex shrinks
        // every sibling with `flexShrink: 1` (the default), and the
        // ScrollView collapses — chips clip to empty outlines because
        // the contentContainer is taller than the now-squeezed outer
        // ScrollView frame.
        //
        // `height: 36` matches the intrinsic content height (chip:
        // typography.caption lineHeight 18 + pill paddingVertical
        // 2×4 + border 2×1 = 28; plus contentContainer paddingVertical
        // 2×4 = 36). Pinning the outer ScrollView to that exact value
        // and refusing to shrink immunises the strip against grid
        // size. Belt-and-braces; either alone would suffice, both
        // together makes the intent obvious to future readers.
        height: 36,
        flexGrow: 0,
        flexShrink: 0,
        marginBottom: spacing.sm,
    },
    genreScrollContent: {
        // Horizontal padding so the first / last chip don't sit
        // flush against the screen edge. `gap` spaces chips evenly
        // without per-chip margins. paddingVertical is the bit that
        // matters for clipping: the pill's borderWidth + lineHeight
        // can extend past the contentContainer's measured height in
        // a horizontal ScrollView with alignItems: center, leaving
        // the top sliver visible and the bottom clipped. A few px
        // of vertical breathing room makes the contentContainer
        // measure tall enough for the full chip.
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.xs,
        gap: spacing.xs,
        alignItems: 'center',
    },
    sortButton: {
        // Right-aligned tappable cluster: icon + current sort label.
        // Tap opens the Alert.alert menu — known v1 shape; refine to a
        // proper menu/bottom-sheet later (see journal).
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.xs,
    },
    sortButtonText: {
        fontWeight: '600',
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
