import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Search, X } from 'lucide-react-native';
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

import { useKeyboard } from '@/hooks/use-keyboard-open';
import supabase from '@/lib/supabase';
import { imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Same shape as the old standalone Search screen: surface only movies and
// TV that have a poster — TMDB returns plenty of poster-less rows we don't
// want to render.
type SearchableItem =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

const POSTER_WIDTH = 56;
const POSTER_HEIGHT = 84;
const DEBOUNCE_MS = 300;

export default function LibraryAddScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { open: keyboardOpen } = useKeyboard();
    // Optional recommend-flow context. When the user enters this screen
    // from a friend profile's "Recommend something" button, the friend's
    // user id is passed in as `recommendTo`. We forward it as `preselect`
    // to the recommend modal so the recipient is pre-checked, and fetch
    // the handle from profiles to tailor the heading. Fetching (rather
    // than passing the handle in the URL) keeps the DB as the single
    // source of truth for what handle to display.
    const { recommendTo } = useLocalSearchParams<{ recommendTo?: string }>();
    const recommendToId =
        typeof recommendTo === 'string' && recommendTo.length > 0
            ? recommendTo
            : null;

    const [recipientHandle, setRecipientHandle] = useState<string | null>(null);

    useEffect(() => {
        if (!recommendToId) return;
        let active = true;
        (async () => {
            try {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('handle')
                    .eq('id', recommendToId)
                    .maybeSingle();
                if (!active) return;
                if (error) throw error;
                if (data) setRecipientHandle(data.handle);
            } catch (err) {
                // Header gracefully falls back to the handle-less
                // variant; not worth surfacing this in the UI.
                console.warn('library/add: recipient handle fetch failed', err);
            }
        })();
        return () => {
            active = false;
        };
    }, [recommendToId]);

    // Header copy adapts to the flow:
    //   - default                        "Add to your library"
    //   - recommend mode, handle loaded  "Recommend to @paul"
    //   - recommend mode, handle pending "Recommend something"
    // Kept short so it fits the single-line, centred header between the
    // close button and its mirror spacer (it previously truncated). The
    // pending variant avoids briefly mis-labelling the recommend flow as
    // the library-add flow while the profile lookup is in flight.
    const headerTitle = recommendToId
        ? recipientHandle
            ? `Recommend to @${recipientHandle}`
            : 'Recommend something'
        : 'Add to your library';

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchableItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 300 ms debounce + stale-result guard. Same pattern as the original
    // standalone Search screen — see git history for the trade-offs around
    // active-flag cancellation and Promise.allSettled.
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

    function renderRow({ item }: { item: SearchableItem }) {
        const title = item.media_type === 'movie' ? item.title : item.name;
        const dateField =
            item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');

        // When in "recommend to friend" mode we skip the title detail
        // and drop the user straight into the recommend modal with the
        // friend pre-selected. Otherwise behaves like the standard
        // library-add picker (lands on the detail screen).
        const handlePress = () => {
            if (recommendToId) {
                router.push({
                    pathname: '/title/[mediaType]/[tmdbId]/recommend',
                    params: {
                        mediaType: item.media_type,
                        tmdbId: String(item.id),
                        preselect: recommendToId,
                    },
                });
                return;
            }
            router.push({
                pathname: '/title/[mediaType]/[tmdbId]',
                params: {
                    mediaType: item.media_type,
                    tmdbId: String(item.id),
                },
            });
        };
        return (
            <Pressable
                onPress={handlePress}
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
            <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
                <View style={styles.header}>
                    <Pressable
                        onPress={() => router.back()}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [
                            styles.headerSide,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <X
                            color={palette.text}
                            size={24}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                    <Text
                        style={[
                            typography.heading,
                            styles.headerTitle,
                            { color: palette.text },
                        ]}
                        numberOfLines={1}
                    >
                        {headerTitle}
                    </Text>
                    {/* Spacer so the title stays visually centred */}
                    <View style={styles.headerSide} />
                </View>
            </SafeAreaView>

            <View style={styles.searchBar}>
                <View style={[styles.bar, { backgroundColor: palette.surface }]}>
                    <Search
                        color={palette.textMuted}
                        size={20}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search films and TV shows"
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus
                        returnKeyType="search"
                        onSubmitEditing={() => Keyboard.dismiss()}
                        style={[
                            styles.input,
                            typography.body,
                            { color: palette.text },
                        ]}
                    />
                </View>
            </View>

            <Pressable style={styles.flex} onPress={() => Keyboard.dismiss()}>
                {loading ? (
                    <View style={styles.statusBlock}>
                        <ActivityIndicator color={palette.accent} />
                    </View>
                ) : results === null ? (
                    // Suppress the "Search for…" placeholder while the
                    // keyboard is up — the user is clearly typing, and
                    // a centered prompt floating just above the keyboard
                    // reads as misalignment rather than guidance. When
                    // the keyboard is dismissed (e.g. by tapping the
                    // scrim) the placeholder reappears.
                    keyboardOpen ? null : (
                        <View style={styles.statusBlock}>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Search for a film or TV show
                            </Text>
                        </View>
                    )
                ) : results.length === 0 ? (
                    <View style={styles.statusBlock}>
                        <Text
                            style={[typography.body, { color: palette.textMuted }]}
                            numberOfLines={2}
                        >
                            {error
                                ? error
                                : `No results for "${query.trim()}"`}
                        </Text>
                    </View>
                ) : (
                    <FlatList
                        data={results}
                        keyExtractor={(item) => `${item.media_type}-${item.id}`}
                        renderItem={renderRow}
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
                )}
            </Pressable>
        </View>
    );
}

const HEADER_SIDE_WIDTH = 32;

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
    },
    headerSide: {
        width: HEADER_SIDE_WIDTH,
    },
    headerTitle: {
        flex: 1,
        textAlign: 'center',
    },
    searchBar: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
    },
    bar: {
        // Borderless pill — matches the Home / Library search bars
        // (search-bar.tsx). The surface fill against the page bg is the
        // visual separation; no border needed.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    input: {
        flex: 1,
        // padding zeroed: the parent .bar height owns vertical sizing so
        // the icon and text stay aligned.
        paddingVertical: 0,
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
