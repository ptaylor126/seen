import { Image } from 'expo-image';
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

import { imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// Movies and TV that have a poster — onboarding only ever surfaces
// titles with art so the visual experience doesn't crater when an
// item has no poster_path.
export type SearchableItem =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

const DEBOUNCE_MS = 300;
const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;

interface OnboardingSearchProps {
    placeholder: string;
    onPick: (item: SearchableItem) => void;
    autoFocus?: boolean;
    // Picked TMDB ids the owning screen wants to dim in results (the
    // user already added them). Used in the watchlist step to prevent
    // duplicate picks. Pass an empty array to disable.
    pickedKeys?: readonly string[];
}

// Shared TMDB search input + results list used by the three add-an-item
// onboarding steps (last-watched, best-watched, watchlist). Owns the
// debounce + stale-guard internally; the owning screen handles what to
// do with each picked item via onPick. Auto-clears the query on pick
// so the user can search for the next title (relevant on watchlist).
export function OnboardingSearch({
    placeholder,
    onPick,
    autoFocus = true,
    pickedKeys = [],
}: OnboardingSearchProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

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
        let active = true;
        setLoading(true);
        const handle = setTimeout(async () => {
            try {
                const response = await searchMulti(trimmed, 1);
                if (!active) return;
                const filtered = response.results.filter(
                    (item): item is SearchableItem =>
                        (item.media_type === 'movie' || item.media_type === 'tv') &&
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

    function handlePick(item: SearchableItem) {
        onPick(item);
        // Reset the query so the next search starts blank — important
        // on the watchlist step where the user adds three in a row.
        setQuery('');
        setResults(null);
        setError(null);
    }

    const pickedSet = new Set(pickedKeys);

    function renderRow({ item }: { item: SearchableItem }) {
        const titleText = item.media_type === 'movie' ? item.title : item.name;
        const dateField =
            item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');
        const key = `${item.media_type}:${item.id}`;
        const alreadyPicked = pickedSet.has(key);
        return (
            <Pressable
                onPress={() => !alreadyPicked && handlePick(item)}
                disabled={alreadyPicked}
                style={({ pressed }) => [
                    styles.row,
                    {
                        opacity: alreadyPicked ? 0.4 : pressed ? 0.6 : 1,
                    },
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
                        {titleText}
                    </Text>
                    {metaLine ? (
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            {metaLine}
                        </Text>
                    ) : null}
                    {alreadyPicked && (
                        <Text style={[typography.micro, { color: palette.accent }]}>
                            Added
                        </Text>
                    )}
                </View>
            </Pressable>
        );
    }

    return (
        <View style={styles.container}>
            <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={placeholder}
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus={autoFocus}
                returnKeyType="search"
                onSubmitEditing={() => Keyboard.dismiss()}
                // Hardcoded — see handle.tsx for rationale.
                keyboardAppearance="light"
                style={[
                    styles.input,
                    typography.body,
                    {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                        color: palette.text,
                    },
                ]}
            />
            {loading ? (
                <View style={styles.statusBlock}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : results === null ? null : results.length === 0 ? (
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={2}
                    >
                        {error ? error : `No results for "${query.trim()}"`}
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={results}
                    keyExtractor={(item) => `${item.media_type}-${item.id}`}
                    renderItem={renderRow}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    // flex + minHeight:0 lets the list shrink inside a
                    // flex column when the keyboard pushes things up —
                    // without minHeight:0, results overflow past the
                    // footer because the default minHeight is `auto`
                    // (= content height) in RN.
                    style={styles.list}
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
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        // RN flex children default to minHeight: 'auto' (= content
        // height), meaning a flex:1 column won't actually shrink below
        // its content's natural height. Setting minHeight: 0 lets the
        // results list bound to the parent's allotted space instead
        // of overflowing into the footer.
        minHeight: 0,
    },
    list: {
        flex: 1,
    },
    input: {
        height: 44,
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
        marginBottom: spacing.md,
    },
    statusBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xl,
        paddingHorizontal: spacing.xl,
    },
    listContent: {
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
