import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';

import { imageUrl, searchMulti, type TMDBMediaItem } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// TMDB returns plenty of rows without posters or with non-movie/tv kinds;
// filter them out at the type level so consumers don't have to.
export type SearchableItem =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_POSTER_W = 56;
const SEARCH_RESULT_POSTER_H = 84;

// Vertical distance from the safe-area top inset to the bottom of the
// search bar. Same on Home and Library because both screens use the
// same header geometry (paddingVertical: spacing.md × 2 = 24 + display
// lineHeight 38 + searchBar marginTop spacing.sm 8 + searchBar height
// 44 = 114; rounded up to 116 for a hairline of breathing room before
// the overlay). Screens compute `insets.top + SEARCH_OVERLAY_TOP_OFFSET`
// and pass it as the overlay's `top` prop.
export const SEARCH_OVERLAY_TOP_OFFSET = 116;

export interface SearchBarState {
    query: string;
    setQuery: (q: string) => void;
    results: SearchableItem[] | null;
    loading: boolean;
    error: string | null;
    overlayVisible: boolean;
    inputRef: React.RefObject<TextInput | null>;
    handleFocus: () => void;
    dismiss: () => void;
    handleResultTap: (item: SearchableItem) => void;
}

// Owns every piece of search state + the debounced TMDB query + the
// result-tap navigation. Screens call this once and pass the returned
// state to <SearchBarInput> and <SearchBarOverlay>.
export function useSearchBar(): SearchBarState {
    const router = useRouter();
    const inputRef = useRef<TextInput | null>(null);
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [results, setResults] = useState<SearchableItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 300ms debounce + stale-result guard. Cancellation runs on every
    // query change AND on unmount.
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
        }, SEARCH_DEBOUNCE_MS);

        return () => {
            active = false;
            clearTimeout(handle);
        };
    }, [query]);

    const handleFocus = useCallback(() => {
        setOpen(true);
    }, []);

    const dismiss = useCallback(() => {
        setQuery('');
        setResults(null);
        setError(null);
        setOpen(false);
        inputRef.current?.blur();
    }, []);

    const handleResultTap = useCallback(
        (item: SearchableItem) => {
            dismiss();
            router.push({
                pathname: '/title/[mediaType]/[tmdbId]',
                params: {
                    mediaType: item.media_type,
                    tmdbId: String(item.id),
                },
            });
        },
        [router, dismiss],
    );

    return {
        query,
        setQuery,
        results,
        loading,
        error,
        overlayVisible: open || query.length > 0,
        inputRef,
        handleFocus,
        dismiss,
        handleResultTap,
    };
}

export function SearchBarInput({ state }: { state: SearchBarState }) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    return (
        <View style={styles.row}>
            <View
                style={[
                    styles.bar,
                    {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                    },
                ]}
            >
                <Search
                    color={palette.textMuted}
                    size={20}
                    strokeWidth={ICON_STROKE_WIDTH}
                />
                <TextInput
                    ref={state.inputRef}
                    value={state.query}
                    onChangeText={state.setQuery}
                    onFocus={state.handleFocus}
                    placeholder="Search to add or find anything"
                    placeholderTextColor={palette.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    style={[styles.input, typography.body, { color: palette.text }]}
                />
            </View>
            {state.overlayVisible ? (
                <Pressable
                    onPress={state.dismiss}
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
            ) : null}
        </View>
    );
}

export function SearchBarOverlay({
    state,
    top,
}: {
    state: SearchBarState;
    top: number;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    function renderResult({ item }: { item: SearchableItem }) {
        const titleText = item.media_type === 'movie' ? item.title : item.name;
        const dateField =
            item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');
        return (
            <Pressable
                onPress={() => state.handleResultTap(item)}
                style={({ pressed }) => [
                    styles.resultRow,
                    pressed && { opacity: 0.6 },
                ]}
            >
                <Image
                    source={{ uri: imageUrl(item.poster_path, 'w185') }}
                    style={styles.resultPoster}
                    contentFit="cover"
                    transition={150}
                />
                <View style={styles.resultText}>
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
                </View>
            </Pressable>
        );
    }

    return (
        <View
            style={[
                styles.overlay,
                {
                    top,
                    backgroundColor: palette.bg,
                    borderTopColor: palette.border,
                },
            ]}
        >
            {state.loading ? (
                <View style={styles.statusBlock}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : state.results === null ? (
                // Empty overlay before the user types — the input's
                // placeholder already states the action, so a "Type to
                // search" hint here is redundant and gets cut off behind
                // the keyboard on shorter devices.
                <View style={styles.statusBlock} />
            ) : state.results.length === 0 ? (
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={2}
                    >
                        {state.error
                            ? state.error
                            : `No results for "${state.query.trim()}"`}
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={state.results}
                    keyExtractor={(item) => `${item.media_type}-${item.id}`}
                    renderItem={renderResult}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
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
    row: {
        // Outer row wraps the bar + the conditional Cancel button. The
        // bar gets `flex: 1` so it expands when Cancel is absent and
        // shrinks to accommodate Cancel when it appears, the standard
        // iOS Mail / Notes search-bar shape.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
    },
    bar: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        // Fully pill-shaped — search inputs read as their own object
        // class (vs. content inputs which use radius.md).
        borderRadius: radius.full,
        borderWidth: 1,
        height: 44,
    },
    cancelButton: {
        // Visible only while the overlay is open. Plain text Pressable
        // — matches iOS standard search Cancel.
        paddingHorizontal: spacing.xs,
    },
    input: {
        flex: 1,
        // padding zeroed: the parent .bar height owns vertical sizing so
        // the icon and text stay perfectly aligned.
        paddingVertical: 0,
    },
    overlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        // Above body content so taps inside results land on results,
        // not on whatever's behind. The host screen's header + search
        // bar sit above this top edge in normal flow, so the input
        // stays tappable while the overlay is open.
        zIndex: 10,
    },
    statusBlock: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.xl,
        paddingBottom: spacing.lg,
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    resultPoster: {
        width: SEARCH_RESULT_POSTER_W,
        height: SEARCH_RESULT_POSTER_H,
        borderRadius: radius.sm,
    },
    resultText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: SEARCH_RESULT_POSTER_W + spacing.md,
    },
});
