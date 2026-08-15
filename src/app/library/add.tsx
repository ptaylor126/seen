import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    MagnifyingGlass,
    X,
} from 'phosphor-react-native';
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
    useWindowDimensions,
    View,
} from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import supabase from '@/lib/supabase';
import { fetchTitlesByItems } from '@/lib/titles';
import { imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import {
    posterFrame,
    getPalette,
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

// "From your library" suggestions (recommend-to-friend flow only).
const SUGGEST_MIN_RATING = 8; // half-star integer scale — 8 = 4 stars.
const SUGGEST_LIMIT = 30;
const SUGGEST_COLS = 3;
const SUGGEST_GAP = spacing.sm;
const SUGGEST_POSTER_ASPECT = 1.5; // 2:3 poster

interface Suggestion {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    posterPath: string;
    title: string;
}

function suggestCellWidth(screenWidth: number): number {
    const usable = screenWidth - 2 * spacing.base;
    return Math.floor((usable - (SUGGEST_COLS - 1) * SUGGEST_GAP) / SUGGEST_COLS);
}

export default function LibraryAddScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { width: screenWidth } = useWindowDimensions();
    // Real IME inset (both platforms) so the suggestion grid can scroll clear
    // of the auto-focused keyboard — the branch's established pattern.
    const keyboardHeight = useKeyboardState((state) => state.height);
    // Optional recommend-flow context. When the user enters this screen
    // from a friend profile's "Recommend something" button, the friend's
    // user id is passed in as `recommendTo`. We forward it as `preselect`
    // to the recommend modal so the recipient is pre-checked, and fetch
    // the handle from profiles to tailor the heading. Fetching (rather
    // than passing the handle in the URL) keeps the DB as the single
    // source of truth for what handle to display.
    const { recommendTo, recommendMode } = useLocalSearchParams<{
        recommendTo?: string;
        recommendMode?: string;
    }>();
    const recommendToId =
        typeof recommendTo === 'string' && recommendTo.length > 0
            ? recommendTo
            : null;
    // TITLE-FIRST recommend: the mirror of recipient-first. The user picks
    // a title here, then chooses recipients on the recommend screen (which
    // starts with an empty selection when no `preselect` is forwarded).
    // Entered from surfaces that prompt "recommend something" without a
    // recipient in mind. recommendTo takes precedence if both are somehow
    // passed — recipient-first is the more specific intent.
    const titleFirstMode = recommendMode === 'title-first' && !recommendToId;
    // Either recommend flavour. Everything that distinguishes "picking a
    // title to RECOMMEND" from "picking a title to ADD" keys off this.
    const anyRecommendMode = recommendToId !== null || titleFirstMode;

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
        : titleFirstMode
          ? // Distinct from recipient-first's pending-handle string
            // ('Recommend something'), which would otherwise make the two
            // modes look identical while a handle is in flight.
            'Recommend a title'
          : 'Add to your library';

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchableItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // "From your library" suggestions, loaded once on mount in recommend mode.
    // null = not loaded / not applicable; [] = loaded but nothing rated 8+.
    const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);

    // Load the user's own highly-rated library titles (rating >= 8), newest
    // rating first, capped — only in the recommend-to-friend flow. Poster/title
    // come from the shared titles catalogue. Best-effort: any failure leaves the
    // area blank (no message), same as having nothing rated 8+.
    useEffect(() => {
        if (!anyRecommendMode) return;
        let active = true;
        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const userId = session?.user.id;
                if (!userId) return;
                const { data: rows, error: itemsError } = await supabase
                    .from('items')
                    .select('tmdb_id, media_type')
                    .eq('user_id', userId)
                    .gte('rating', SUGGEST_MIN_RATING)
                    .order('updated_at', { ascending: false })
                    .limit(SUGGEST_LIMIT);
                if (itemsError) throw itemsError;
                if (!active) return;
                const items = rows ?? [];
                if (items.length === 0) {
                    setSuggestions([]);
                    return;
                }
                const titleByKey = await fetchTitlesByItems(items);
                if (!active) return;
                const built = items.flatMap((row): Suggestion[] => {
                    if (row.media_type !== 'movie' && row.media_type !== 'tv') {
                        return [];
                    }
                    const t = titleByKey.get(`${row.media_type}:${row.tmdb_id}`);
                    // Skip poster-less titles — the grid is all posters.
                    if (!t?.poster_path) return [];
                    return [
                        {
                            tmdbId: row.tmdb_id,
                            mediaType: row.media_type,
                            posterPath: t.poster_path,
                            title: t.title ?? '',
                        },
                    ];
                });
                setSuggestions(built);
            } catch (err) {
                console.warn('library/add: suggestions load failed', err);
                if (active) setSuggestions([]);
            }
        })();
        return () => {
            active = false;
        };
    }, [anyRecommendMode]);

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

    // Tapping a suggestion goes STRAIGHT into the send flow with the friend
    // preselected — identical to picking a searched title in recommend mode
    // (no title-detail screen in between).
    function handleSuggestionPress(item: Suggestion) {
        if (!anyRecommendMode) return;
        router.push({
            pathname: '/title/[mediaType]/[tmdbId]/recommend',
            params: {
                mediaType: item.mediaType,
                tmdbId: String(item.tmdbId),
                // Recipient-first forwards the preselect; title-first omits
                // it entirely so the recommend screen opens with an empty
                // selection and the user picks recipients there, and asks
                // for a full-stack dismiss on send (see handlePress).
                ...(recommendToId
                    ? { preselect: recommendToId }
                    : { dismissOnSend: '1' }),
            },
        });
    }

    function renderSuggestionCell({ item }: { item: Suggestion }) {
        const cellWidth = suggestCellWidth(screenWidth);
        const cellHeight = Math.floor(cellWidth * SUGGEST_POSTER_ASPECT);
        return (
            <Pressable
                onPress={() => handleSuggestionPress(item)}
                accessibilityRole="button"
                accessibilityLabel={`Recommend ${item.title}`}
                style={({ pressed }) => pressed && { opacity: 0.6 }}
            >
                <Image
                    source={{ uri: imageUrl(item.posterPath, 'w342') }}
                    style={[
                        styles.suggestPoster,
                        { width: cellWidth, height: cellHeight },
                    ]}
                    contentFit="cover"
                    transition={150}
                />
            </Pressable>
        );
    }

    // Fills the pre-search empty area with the user's highly-rated library
    // titles. Recommend mode only; blank (as today) when there are none.
    function renderSuggestions() {
        if (!anyRecommendMode || !suggestions || suggestions.length === 0) {
            return null;
        }
        return (
            <View style={styles.flex}>
                <Text
                    style={[
                        typography.micro,
                        styles.suggestLabel,
                        { color: palette.textMuted },
                    ]}
                >
                    FROM YOUR LIBRARY
                </Text>
                <FlatList
                    data={suggestions}
                    key={`suggest-${SUGGEST_COLS}`}
                    style={styles.flex}
                    keyExtractor={(item) => `${item.mediaType}-${item.tmdbId}`}
                    renderItem={renderSuggestionCell}
                    numColumns={SUGGEST_COLS}
                    columnWrapperStyle={{ columnGap: SUGGEST_GAP }}
                    ItemSeparatorComponent={() => (
                        <View style={{ height: SUGGEST_GAP }} />
                    )}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    onScrollBeginDrag={() => Keyboard.dismiss()}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={[
                        styles.suggestGridContent,
                        { paddingBottom: keyboardHeight + spacing.lg },
                    ]}
                />
            </View>
        );
    }

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
            // Recipient-first: straight to the send flow, recipient
            // pre-checked. Unchanged.
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
            // Title-first: same destination, NO preselect — the recommend
            // screen opens with an empty selection so the user picks who.
            if (titleFirstMode) {
                router.push({
                    pathname: '/title/[mediaType]/[tmdbId]/recommend',
                    params: {
                        mediaType: item.media_type,
                        tmdbId: String(item.id),
                        // Title-first is launched from a surface the user
                        // should return to on send (home), not from this
                        // picker. Tells the recommend screen to unwind the
                        // whole modal stack instead of popping one level.
                        // Cancel still pops back HERE so a wrong pick can
                        // be re-chosen.
                        dismissOnSend: '1',
                    },
                });
                return;
            }
            // Plain add: the title detail screen. Unchanged.
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
                    <MagnifyingGlass
                        color={palette.textMuted}
                        size={20}
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
                    // Pre-search: show "From your library" suggestions in the
                    // recommend flow; otherwise (or with nothing rated 8+) the
                    // area stays blank, no message.
                    renderSuggestions()
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
        ...posterFrame,
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
    suggestLabel: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    suggestGridContent: {
        paddingHorizontal: spacing.base,
    },
    suggestPoster: {
        ...posterFrame,
        borderRadius: radius.sm,
    },
});
