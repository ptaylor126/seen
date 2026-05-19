import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
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

import { imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// search/multi returns movies, TV, and people; we surface only movies + TV
// that have a poster (no-poster rows feel broken in a visual list, so we
// drop them before render).
type SearchableItem =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;
const DEBOUNCE_MS = 300;

export default function SearchScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchableItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed) {
            setResults(null);
            setError(null);
            setLoading(false);
            return;
        }

        // Cancel-via-flag guards against a slow earlier request resolving
        // after the user has typed further and kicked off a newer one.
        let active = true;
        setLoading(true);

        const handle = setTimeout(async () => {
            try {
                const response = await searchMulti(trimmed, 1);
                if (!active) return;
                const filtered = response.results.filter(
                    (item): item is SearchableItem =>
                        (item.media_type === 'movie' ||
                            item.media_type === 'tv') &&
                        !!item.poster_path,
                );
                setResults(filtered);
                setError(null);
            } catch (err) {
                if (!active) return;
                setResults([]);
                setError(err instanceof Error ? err.message : 'Search failed');
            } finally {
                if (active) setLoading(false);
            }
        }, DEBOUNCE_MS);

        return () => {
            active = false;
            clearTimeout(handle);
        };
    }, [query]);

    function renderRow({ item }: { item: SearchableItem }) {
        const title = item.media_type === 'movie' ? item.title : item.name;
        const dateField = item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');

        return (
            <Pressable
                onPress={() =>
                    router.push(`/title/${item.media_type}/${item.id}`)
                }
                style={({ pressed }) => [
                    styles.row,
                    pressed && { opacity: 0.6 },
                ]}
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
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
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
            </View>

            {/* Tap anywhere below the input to dismiss the keyboard. Row
                taps that gain their own onPress later will win because
                child handlers consume the gesture before this wrapper. */}
            <Pressable style={styles.body} onPress={Keyboard.dismiss}>
                {loading && (
                    <View style={styles.statusBlock}>
                        <ActivityIndicator color={palette.accent} />
                    </View>
                )}

                {!loading && results === null && (
                    <View style={styles.statusBlock}>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            Search for a film or TV show
                        </Text>
                    </View>
                )}

                {!loading && results !== null && results.length === 0 && (
                    <View style={styles.statusBlock}>
                        <Text
                            style={[typography.body, { color: palette.textMuted }]}
                            numberOfLines={2}
                        >
                            {error ? error : `No results for "${query.trim()}"`}
                        </Text>
                    </View>
                )}

                {!loading && results !== null && results.length > 0 && (
                    <FlatList
                        data={results}
                        keyExtractor={(item) => `${item.media_type}-${item.id}`}
                        renderItem={renderRow}
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={styles.listContent}
                        ItemSeparatorComponent={() => (
                            <View
                                style={[styles.separator, { backgroundColor: palette.border }]}
                            />
                        )}
                    />
                )}
            </Pressable>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    body: { flex: 1 },
    searchBar: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
    },
    input: {
        height: 44,
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
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
