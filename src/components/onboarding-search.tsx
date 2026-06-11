import { Image } from 'expo-image';
import { Fragment, useEffect, useState } from 'react';
import {
    ActivityIndicator,
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
    // Fires whenever the results list transitions to a non-empty
    // state. The owning screen uses this to scroll its ScrollView so
    // the search input + first result land at the top of the visible
    // area.
    onResultsRendered?: () => void;
    // Fires once after the outer container is laid out, with the
    // container's y position inside its parent (the screen's
    // ScrollView contentContainer). The owning screen stores this
    // and scrolls to it on onResultsRendered.
    onContainerLayout?: (y: number) => void;
}

// Shared TMDB search input + results list used by the two add-an-item
// onboarding steps (best-watched, currently-watching).
// Owns the debounce + stale-guard internally; the owning screen handles
// what to do with each picked item via onPick. Results render as a
// plain flex column (NOT a FlatList) because each owning screen wraps
// its body in a ScrollView, and nesting a vertical FlatList inside a
// ScrollView produces broken scroll behaviour. At onboarding scale
// (max ~20 search results), mapping into Views is fine — no
// virtualization needed.
export function OnboardingSearch({
    placeholder,
    onPick,
    autoFocus = true,
    pickedKeys = [],
    onResultsRendered,
    onContainerLayout,
}: OnboardingSearchProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchableItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    // Boolean rather than the raw error string: the user never sees
    // the technical "tmdb-proxy: Failed to send a request to the Edge
    // Function" wording — that's a scary read at first-run onboarding,
    // where the user has zero trust capital with the app yet. callProxy
    // already silently retries once on FunctionsFetchError, so reaching
    // this branch means BOTH attempts failed — almost certainly a
    // genuine connectivity issue (or, less commonly, a real outage).
    // The friendly message + tap-to-retry covers both cases.
    const [searchFailed, setSearchFailed] = useState(false);
    // Bumped by the tap-to-retry affordance to force the search effect
    // to re-run with the same query (would otherwise be a no-op since
    // the query dep hasn't changed). The 300ms debounce window applies
    // to the retry too — feels like a brief spinner rather than an
    // immediate response, which is fine.
    const [retryNonce, setRetryNonce] = useState(0);

    // Fire onResultsRendered after a state update that produced a
    // non-empty results list — lets the parent ScrollView scroll to
    // the new content. Skipped for empty arrays (no results) and null
    // (initial / cleared).
    useEffect(() => {
        if (results && results.length > 0) {
            onResultsRendered?.();
        }
    }, [results, onResultsRendered]);

    useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed) {
            setResults(null);
            setSearchFailed(false);
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
                setSearchFailed(false);
            } catch (err) {
                if (!active) return;
                // Keep the raw error in the console for debugging —
                // never surface it to the user. The friendly message
                // rendered below handles their side.
                console.warn(
                    '[onboarding search] tmdb-proxy call failed:',
                    err,
                );
                setResults([]);
                setSearchFailed(true);
            } finally {
                if (active) setLoading(false);
            }
        }, DEBOUNCE_MS);
        return () => {
            active = false;
            clearTimeout(handle);
        };
    }, [query, retryNonce]);

    function handleRetry() {
        setRetryNonce((n) => n + 1);
    }

    function handlePick(item: SearchableItem) {
        onPick(item);
        // Reset the query so the next search starts blank — important
        // on the watchlist step where the user adds three in a row.
        setQuery('');
        setResults(null);
        setSearchFailed(false);
    }

    const pickedSet = new Set(pickedKeys);

    function renderRow(item: SearchableItem) {
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
                key={key}
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
        <View
            style={styles.container}
            onLayout={(e) => onContainerLayout?.(e.nativeEvent.layout.y)}
        >
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
            ) : results === null ? null : searchFailed ? (
                // Friendly failure block. callProxy already retried
                // once silently, so reaching this point means both
                // attempts failed — almost always a connectivity
                // issue from the device side. Tap-to-retry re-fires
                // the search effect without making the user re-type.
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={2}
                    >
                        Couldn’t reach search — check your connection.
                    </Text>
                    <Pressable
                        onPress={handleRetry}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Try search again"
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
                            ]}
                        >
                            Try again
                        </Text>
                    </Pressable>
                </View>
            ) : results.length === 0 ? (
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={2}
                    >
                        No results for &quot;{query.trim()}&quot;
                    </Text>
                </View>
            ) : (
                <View style={styles.resultList}>
                    {results.map((item, i) => (
                        <Fragment key={`${item.media_type}-${item.id}`}>
                            {i > 0 && (
                                <View
                                    style={[
                                        styles.separator,
                                        { backgroundColor: palette.border },
                                    ]}
                                />
                            )}
                            {renderRow(item)}
                        </Fragment>
                    ))}
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        // No flex:1 — the owning screen wraps the body in a ScrollView,
        // so the search lays out at its natural content height and the
        // ScrollView handles overflow.
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
        // Breathing room between message + tap-to-retry in the failure
        // block. No-op for the single-child loading + "no results"
        // blocks (`gap` requires >1 child to render any space).
        gap: spacing.sm,
    },
    resultList: {
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
