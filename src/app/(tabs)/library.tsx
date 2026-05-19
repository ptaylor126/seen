import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Keyboard,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

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
}

// search/multi returns movies, TV, and people; we surface only movies + TV
// that have a poster (matches the old standalone search screen).
type SearchableItem =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

const TABS: readonly ItemStatus[] = ['watchlist', 'watching', 'watched'] as const;
const TAB_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};
const EMPTY_MESSAGES: Record<ItemStatus, string> = {
    watchlist: 'Your watchlist is empty. Search above to add something.',
    watching: 'Nothing currently watching.',
    watched: 'No watched titles yet.',
};

const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;
const DEBOUNCE_MS = 300;

// N+1 fetch — see prior journal entry for the trade-off comment. Posters
// cache at the expo-image layer; only the JSON metadata is the cost.
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

    // ---- Library state (watchlist / watching / watched) ----
    const [activeTab, setActiveTab] = useState<ItemStatus>('watchlist');
    const [rows, setRows] = useState<LibraryRow[]>([]);
    const [libraryLoading, setLibraryLoading] = useState(true);
    const [libraryError, setLibraryError] = useState<string | null>(null);

    // ---- Search state ----
    const [query, setQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchableItem[] | null>(null);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    const isSearching = query.length > 0;

    // Library fetch — refetches on tab change and on screen focus
    // (e.g., returning from the title detail modal after adding an item).
    useFocusEffect(
        useCallback(() => {
            let active = true;

            const load = async () => {
                setLibraryLoading(true);
                setLibraryError(null);
                try {
                    const { data: items, error: itemsError } = await supabase
                        .from('items')
                        .select(
                            'id, tmdb_id, media_type, rating, watched_at, updated_at',
                        )
                        .eq('status', activeTab)
                        .order('updated_at', { ascending: false });

                    if (itemsError) throw itemsError;
                    if (!active) return;

                    const itemList = items ?? [];

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
                        return {
                            id: row.id,
                            tmdb_id: row.tmdb_id,
                            media_type: row.media_type as MediaType,
                            rating: row.rating,
                            watched_at: row.watched_at,
                            updated_at: row.updated_at,
                            ...meta,
                            metaLoaded: result.status === 'fulfilled',
                        };
                    });

                    setRows(combined);
                } catch (err) {
                    if (!active) return;
                    console.error('library fetch failed:', err);
                    setLibraryError(
                        err instanceof Error ? err.message : 'Failed to load library',
                    );
                    setRows([]);
                } finally {
                    if (active) setLibraryLoading(false);
                }
            };

            load();

            return () => {
                active = false;
            };
        }, [activeTab]),
    );

    // Search effect — 300ms debounce + stale-result guard. Identical
    // pattern to the old standalone search screen.
    useEffect(() => {
        const trimmed = query.trim();
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
        }, DEBOUNCE_MS);

        return () => {
            active = false;
            clearTimeout(handle);
        };
    }, [query]);

    function handleCancelSearch() {
        setQuery('');
        Keyboard.dismiss();
    }

    function renderLibraryRow({ item }: { item: LibraryRow }) {
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [item.year, mediaLabel].filter(Boolean).join(' · ');

        const watchedDate = item.watched_at
            ? new Date(item.watched_at).toLocaleDateString()
            : '';
        const ratingDisplay = item.rating !== null ? `${item.rating}★` : '';
        const watchedLine = [ratingDisplay, watchedDate].filter(Boolean).join(' · ');
        const showWatchedLine = activeTab === 'watched' && watchedLine.length > 0;

        return (
            <Pressable
                onPress={() =>
                    router.push(`/title/${item.media_type}/${item.tmdb_id}`)
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
                    {showWatchedLine ? (
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            {watchedLine}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    function renderSearchRow({ item }: { item: SearchableItem }) {
        const title = item.media_type === 'movie' ? item.title : item.name;
        const dateField =
            item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');

        return (
            <Pressable
                onPress={() =>
                    router.push(`/title/${item.media_type}/${item.id}`)
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Image
                    source={{ uri: imageUrl(item.poster_path, 'w185') }}
                    style={styles.poster}
                    contentFit="cover"
                    transition={150}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {title}
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        {metaLine}
                    </Text>
                </View>
            </Pressable>
        );
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Library" />

            <View style={styles.searchBar}>
                <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search films and TV shows"
                    placeholderTextColor={palette.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    style={[
                        styles.input,
                        typography.body,
                        {
                            backgroundColor: palette.surface,
                            color: palette.text,
                            borderColor: palette.border,
                        },
                    ]}
                />
                {isSearching && (
                    <Pressable
                        onPress={handleCancelSearch}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <Text style={[typography.body, { color: palette.accent }]}>
                            Cancel
                        </Text>
                    </Pressable>
                )}
            </View>

            {isSearching ? (
                /* Search body — same nested-Pressable keyboard-dismiss
                   pattern as the old search screen; row Pressables
                   consume the tap before the wrapper sees it. */
                <Pressable style={styles.flex} onPress={Keyboard.dismiss}>
                    {searchLoading ? (
                        <View style={styles.statusBlock}>
                            <ActivityIndicator color={palette.accent} />
                        </View>
                    ) : searchResults !== null &&
                      searchResults.length === 0 ? (
                        <View style={styles.statusBlock}>
                            <Text
                                style={[typography.body, { color: palette.textMuted }]}
                                numberOfLines={2}
                            >
                                {searchError
                                    ? searchError
                                    : `No results for "${query.trim()}"`}
                            </Text>
                        </View>
                    ) : searchResults !== null && searchResults.length > 0 ? (
                        <FlatList
                            data={searchResults}
                            keyExtractor={(item) => `${item.media_type}-${item.id}`}
                            renderItem={renderSearchRow}
                            // keyboardShouldPersistTaps + the outer Pressable
                            // handle taps in non-FlatList space; the FlatList's
                            // own ScrollView absorbs taps inside its bounds, so
                            // we additionally dismiss the keyboard on scroll —
                            // the most common "I want to see results" gesture.
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                            onScrollBeginDrag={() => Keyboard.dismiss()}
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
                    ) : null}
                </Pressable>
            ) : (
                <>
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

                    {libraryLoading ? (
                        <View style={styles.statusBlock}>
                            <ActivityIndicator color={palette.accent} />
                        </View>
                    ) : libraryError ? (
                        <View style={styles.statusBlock}>
                            <Text
                                style={[typography.body, { color: palette.error }]}
                                numberOfLines={3}
                            >
                                {libraryError}
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
                    ) : (
                        <FlatList
                            data={rows}
                            keyExtractor={(item) => item.id}
                            renderItem={renderLibraryRow}
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
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
    },
    input: {
        flex: 1,
        height: 44,
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
    },
    tabs: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
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
});
