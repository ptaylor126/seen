import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Search, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    SectionList,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';

import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import {
    imageUrl,
    searchMulti,
    type TMDBMediaItem,
    type TMDBPersonSummary,
} from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// TMDB returns plenty of rows without posters / profile images and a
// mix of media types — filter at the type level so consumers don't have
// to. People are included now (the "search by person" feature) but kept
// as a separate variant of the union so renderers + tap-handlers branch
// cleanly on media_type.
export type SearchableTitle =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

export type SearchablePerson = TMDBPersonSummary & {
    media_type: 'person';
    profile_path: string; // narrowed from `string | null` after filter
};

export type SearchableItem = SearchableTitle | SearchablePerson;

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_POSTER_W = 56;
const SEARCH_RESULT_POSTER_H = 84;
// Profile images render as circles, sized to match the title-row
// poster height for a consistent visual rhythm across the blended
// results section.
const SEARCH_RESULT_PROFILE_SIZE = 56;
// Cap the People section in the overlay so a query like "john" with
// 20 matching people doesn't drown the title results. Five disambiguates
// well in practice; a user wanting a specific actor narrows by typing
// more.
const PEOPLE_RESULTS_CAP = 5;

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
                // Keep titles with posters AND people with profile
                // images. Same "no image, skip it" filter applies to
                // both — drops the visually broken rows and the data-
                // poor TMDB entries in one rule.
                const filtered = response.results.filter(
                    (item): item is SearchableItem => {
                        if (
                            item.media_type === 'movie' ||
                            item.media_type === 'tv'
                        ) {
                            return !!item.poster_path;
                        }
                        if (item.media_type === 'person') {
                            return !!item.profile_path;
                        }
                        return false;
                    },
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
            if (item.media_type === 'person') {
                router.push({
                    pathname: '/person/[personId]',
                    params: { personId: String(item.id) },
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
                {/* Inline clear-X: shows when the field has text. Tap
                    clears the query but keeps focus + the overlay open
                    so the user can re-type without exiting search. The
                    sibling Cancel button (rendered when overlayVisible)
                    is what fully exits — X is the "clear and keep
                    typing" sub-action. */}
                {state.query.length > 0 ? (
                    <Pressable
                        onPress={() => state.setQuery('')}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <X
                            color={palette.textMuted}
                            size={18}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                ) : null}
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

// TMDB's known_for_department uses verb-form ("Acting", "Directing",
// "Writing") which reads awkwardly as a row label. Map to friendly
// nouns. Anything we don't have a mapping for falls through unchanged
// — TMDB only really uses ~6 values here.
function friendlyDepartment(value: string | undefined): string {
    if (!value) return '';
    switch (value) {
        case 'Acting':
            return 'Actor';
        case 'Directing':
            return 'Director';
        case 'Writing':
            return 'Writer';
        case 'Production':
            return 'Producer';
        default:
            return value;
    }
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
    // The overlay is absolute-positioned to the screen bottom (under the
    // floating nav), so the results list needs the same bottom inset the
    // other tab lists use — nav height + bottom gap + safe-area inset —
    // plus a small margin so the last row clears the nav pill and stays
    // tappable. Reuses the shared hook so it tracks nav-height changes.
    const tabBarInset = useFloatingTabBarInset();

    function renderTitleRow(item: SearchableTitle) {
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

    function renderPersonRow(item: SearchablePerson) {
        const department = friendlyDepartment(item.known_for_department);
        return (
            <Pressable
                onPress={() => state.handleResultTap(item)}
                style={({ pressed }) => [
                    styles.resultRow,
                    pressed && { opacity: 0.6 },
                ]}
            >
                <Image
                    source={{ uri: imageUrl(item.profile_path, 'w185') }}
                    style={styles.resultProfile}
                    contentFit="cover"
                    transition={150}
                />
                <View style={styles.resultText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {item.name}
                    </Text>
                    {department ? (
                        <Text
                            style={[typography.caption, { color: palette.textMuted }]}
                        >
                            {department}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    // Partition the blended results into a People section (capped) and
    // a Titles section. People appear first because a query that names
    // a person is much more likely to be searching for them than for a
    // title containing their name. Empty sections are dropped so the
    // user doesn't see a "PEOPLE" header with nothing under it on a
    // pure-title query.
    const peopleResults = (state.results ?? [])
        .filter((r): r is SearchablePerson => r.media_type === 'person')
        .slice(0, PEOPLE_RESULTS_CAP);
    const titleResults = (state.results ?? []).filter(
        (r): r is SearchableTitle => r.media_type !== 'person',
    );
    const sections: { title: string; data: SearchableItem[] }[] = [];
    if (peopleResults.length > 0) {
        sections.push({ title: 'PEOPLE', data: peopleResults });
    }
    if (titleResults.length > 0) {
        sections.push({ title: 'TITLES', data: titleResults });
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
                <SectionList
                    sections={sections}
                    keyExtractor={(item) => `${item.media_type}-${item.id}`}
                    renderItem={({ item }) =>
                        item.media_type === 'person'
                            ? renderPersonRow(item)
                            : renderTitleRow(item)
                    }
                    renderSectionHeader={({ section }) => (
                        <View
                            style={[
                                styles.sectionHeader,
                                { backgroundColor: palette.bg },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionHeaderText,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {section.title}
                            </Text>
                        </View>
                    )}
                    // Sticky headers would look fine but the section
                    // count is small (max 2) and the header
                    // breathing room reads cleaner without them.
                    stickySectionHeadersEnabled={false}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    contentContainerStyle={[
                        styles.listContent,
                        { paddingBottom: tabBarInset + spacing.lg },
                    ]}
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
        // Borderless — the surface fill against the page bg is the
        // visual separation (matches the borderless local search bars
        // on Library + friend's-library). Pairing fill + border reads
        // as a generic input pill; dropping the border lets the
        // accent + pill shape do the work.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
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
    resultProfile: {
        width: SEARCH_RESULT_PROFILE_SIZE,
        height: SEARCH_RESULT_PROFILE_SIZE,
        borderRadius: SEARCH_RESULT_PROFILE_SIZE / 2,
    },
    resultText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: SEARCH_RESULT_POSTER_W + spacing.md,
    },
    sectionHeader: {
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
    },
    sectionHeaderText: {
        letterSpacing: 1.2,
    },
});
