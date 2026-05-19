import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
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

import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
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

const TABS: readonly ItemStatus[] = ['watchlist', 'watching', 'watched'] as const;

const TAB_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};

const EMPTY_MESSAGES: Record<ItemStatus, string> = {
    watchlist: 'Your watchlist is empty. Search to add something.',
    watching: 'Nothing currently watching.',
    watched: 'No watched titles yet.',
};

const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;

// Data fetch strategy is N+1: one query for items, then one TMDB call per
// item. Acceptable while the library is small (~10-20 items per user).
// When real testing surfaces 100+ item libraries, switch to one of:
//   - denormalise title/poster_path/year into items at INSERT time
//   - cache TMDB responses in AsyncStorage with a TTL
//   - hit TMDB's `find` endpoint (one round trip per external_source id)
// Posters themselves are cached by expo-image at the disk layer, so the
// real cost is the JSON metadata fetch.
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

    const [activeTab, setActiveTab] = useState<ItemStatus>('watchlist');
    const [rows, setRows] = useState<LibraryRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // useFocusEffect re-runs when the screen is focused AND when the
    // callback identity changes (i.e. on tab switch via the [activeTab]
    // dep). Cleanup flips `active` so a slower in-flight fetch can't
    // overwrite state for a tab the user has already left.
    useFocusEffect(
        useCallback(() => {
            let active = true;

            const load = async () => {
                setLoading(true);
                setError(null);
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

                    // Fetch every title's metadata in parallel; one failure
                    // doesn't kill the rest. Failed rows fall back to a
                    // placeholder title.
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

    function renderRow({ item }: { item: LibraryRow }) {
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

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
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
            ) : (
                <FlatList
                    data={rows}
                    keyExtractor={(item) => item.id}
                    renderItem={renderRow}
                    contentContainerStyle={styles.listContent}
                    ItemSeparatorComponent={() => (
                        <View
                            style={[styles.separator, { backgroundColor: palette.border }]}
                        />
                    )}
                />
            )}
        </SafeAreaView>
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
});
