import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Bell, Plus, Search } from 'lucide-react-native';
import { useCallback, useState } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { useUnreadCount } from '@/hooks/use-unread-count';
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
    watchlist: 'Your watchlist is empty. Tap + to add something.',
    watching: 'Nothing currently watching.',
    watched: 'No watched titles yet.',
};

const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;

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

    // Local search state — filters the loaded library by title substring.
    // Distinct from TMDB search (which lives in the /library/add modal
    // behind the Plus icon).
    const [searching, setSearching] = useState(false);
    const [filter, setFilter] = useState('');

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

    function enterSearch() {
        setSearching(true);
    }

    function exitSearch() {
        setSearching(false);
        setFilter('');
        Keyboard.dismiss();
    }

    // Filter applied client-side over the already-loaded rows. Case-
    // insensitive substring match on the displayed title.
    const trimmedFilter = filter.trim();
    const filteredRows =
        trimmedFilter.length === 0
            ? rows
            : rows.filter((r) =>
                  r.title.toLowerCase().includes(trimmedFilter.toLowerCase()),
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
            <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
                <View style={styles.header}>
                    {searching ? (
                        <>
                            <TextInput
                                value={filter}
                                onChangeText={setFilter}
                                placeholder="Search your library"
                                placeholderTextColor={palette.textMuted}
                                autoCapitalize="none"
                                autoCorrect={false}
                                autoFocus
                                returnKeyType="search"
                                onSubmitEditing={() => Keyboard.dismiss()}
                                style={[
                                    styles.searchInput,
                                    typography.body,
                                    {
                                        backgroundColor: palette.surface,
                                        color: palette.text,
                                        borderColor: palette.border,
                                    },
                                ]}
                            />
                            <Pressable
                                onPress={exitSearch}
                                hitSlop={spacing.sm}
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
                        </>
                    ) : (
                        <>
                            <Text
                                style={[typography.display, { color: palette.text }]}
                                numberOfLines={1}
                            >
                                Library
                            </Text>
                            <View style={styles.iconRow}>
                                <Pressable
                                    onPress={enterSearch}
                                    hitSlop={spacing.sm}
                                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                                >
                                    <Search color={palette.text} size={24} />
                                </Pressable>
                                <Pressable
                                    onPress={() =>
                                        router.push({ pathname: '/library/add' })
                                    }
                                    hitSlop={spacing.sm}
                                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                                >
                                    <Plus color={palette.text} size={24} />
                                </Pressable>
                                <Pressable
                                    onPress={() =>
                                        router.push({ pathname: '/inbox' })
                                    }
                                    hitSlop={spacing.sm}
                                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                                >
                                    <View>
                                        <Bell color={palette.text} size={24} />
                                        {unreadCount > 0 && (
                                            <View
                                                style={[
                                                    styles.badge,
                                                    { backgroundColor: palette.accent },
                                                ]}
                                            >
                                                <Text
                                                    style={[
                                                        styles.badgeText,
                                                        {
                                                            color: palette.textInverse,
                                                        },
                                                    ]}
                                                >
                                                    {unreadCount > 9
                                                        ? '9+'
                                                        : String(unreadCount)}
                                                </Text>
                                            </View>
                                        )}
                                    </View>
                                </Pressable>
                            </View>
                        </>
                    )}
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
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={3}
                    >
                        {trimmedFilter.length > 0
                            ? `No matches for "${trimmedFilter}"`
                            : EMPTY_MESSAGES[activeTab]}
                    </Text>
                </View>
            ) : (
                <FlatList
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
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        gap: spacing.sm,
    },
    iconRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.base,
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -6,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        fontSize: 10,
        fontWeight: '700',
    },
    searchInput: {
        flex: 1,
        height: 40,
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
    },
    cancelButton: {
        paddingHorizontal: spacing.xs,
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
