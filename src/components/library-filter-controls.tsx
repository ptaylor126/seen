/**
 * Shared filter / sort / genre controls for library-shaped screens.
 *
 * Lifted from src/app/(tabs)/library.tsx so the own-library tab and
 * the friend-library route read identically. State + filtering logic
 * live in useLibraryFilters; this component is pure presentation —
 * pass the hook result + a palette in, get the rendered controls.
 *
 * Renders (vertical order):
 *   1. Controls row: media filter pills (All / Movies / TV) on the
 *      left; Genre toggle pill + Sort button on the right.
 *   2. Genre chip strip below the controls row when genreStripOpen
 *      is true AND availableGenres is non-empty. "All genres" sentinel
 *      chip prepended for explicit clear.
 *
 * Deliberately NOT in scope: the search input, the add-from-TMDB
 * overlay, the tab pills. Those stay screen-local — the search visual
 * differs between library (dual-mode bar with add affordance) and
 * friend library (local-filter only); tabs are duplicated but small
 * enough to leave for a future sweep.
 */

import { ArrowDownUp } from 'lucide-react-native';
import {
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { TMDB_GENRE_NAMES } from '@/lib/genres';
import {
    MEDIA_FILTERS,
    MEDIA_FILTER_LABELS,
    SORT_LABELS,
    type MediaFilter,
    type SortOption,
} from '@/lib/use-library-filters';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type Palette = ReturnType<typeof getPalette>;

interface LibraryFilterControlsProps {
    palette: Palette;
    mediaFilter: MediaFilter;
    setMediaFilter: (f: MediaFilter) => void;
    sortBy: SortOption;
    setSortBy: (s: SortOption) => void;
    genreFilter: number | null;
    setGenreFilter: (id: number | null) => void;
    genreStripOpen: boolean;
    setGenreStripOpen: (open: boolean) => void;
    availableGenres: Array<{ id: number; name: string }>;
}

export function LibraryFilterControls({
    palette,
    mediaFilter,
    setMediaFilter,
    sortBy,
    setSortBy,
    genreFilter,
    setGenreFilter,
    genreStripOpen,
    setGenreStripOpen,
    availableGenres,
}: LibraryFilterControlsProps) {
    function openSortMenu() {
        Alert.alert('Sort by', undefined, [
            ...(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => ({
                text: SORT_LABELS[opt] + (sortBy === opt ? '  ✓' : ''),
                onPress: () => setSortBy(opt),
            })),
            { text: 'Cancel', style: 'cancel' as const },
        ]);
    }

    return (
        <>
            <View style={styles.controlsRow}>
                <View style={styles.mediaFilterGroup}>
                    {MEDIA_FILTERS.map((opt) => {
                        const isActive = mediaFilter === opt;
                        return (
                            <Pressable
                                key={opt}
                                onPress={() => setMediaFilter(opt)}
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityLabel={MEDIA_FILTER_LABELS[opt]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isActive }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {MEDIA_FILTER_LABELS[opt]}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
                <View style={styles.rightControls}>
                    {/* Genre toggle pill — reveals/collapses the chip
                        strip below. Default: outlined, label "Genre".
                        Active (genreFilter set): accent-filled, label
                        = the selected genre name. Active visuals
                        derive from one boolean (isGenreActive) so bg
                        / border / text colour / label can't drift
                        out of sync. */}
                    {(() => {
                        const isGenreActive = genreFilter !== null;
                        const activeGenreLabel = isGenreActive
                            ? TMDB_GENRE_NAMES.get(genreFilter) ??
                              `#${genreFilter}`
                            : null;
                        return (
                            <Pressable
                                onPress={() =>
                                    setGenreStripOpen(!genreStripOpen)
                                }
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isGenreActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isGenreActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    isGenreActive
                                        ? `Genre filter: ${activeGenreLabel}. Tap to ${genreStripOpen ? 'hide' : 'show'} options.`
                                        : `${genreStripOpen ? 'Hide' : 'Show'} genre options`
                                }
                                accessibilityState={{
                                    selected: isGenreActive,
                                    expanded: genreStripOpen,
                                }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isGenreActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {isGenreActive
                                        ? activeGenreLabel
                                        : 'Genre'}
                                </Text>
                            </Pressable>
                        );
                    })()}
                    <Pressable
                        onPress={openSortMenu}
                        hitSlop={spacing.xs}
                        style={({ pressed }) => [
                            styles.sortButton,
                            pressed && { opacity: 0.6 },
                        ]}
                        accessibilityLabel={`Sort by ${SORT_LABELS[sortBy]}`}
                        accessibilityRole="button"
                    >
                        <ArrowDownUp
                            color={palette.text}
                            size={14}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                        <Text
                            style={[
                                typography.caption,
                                styles.sortButtonText,
                                { color: palette.text },
                            ]}
                        >
                            {SORT_LABELS[sortBy]}
                        </Text>
                    </Pressable>
                </View>
            </View>

            {/* Genre chip strip — revealed by the Genre toggle pill
                above. Horizontal scroll, full width. Same chip
                styling as the media filter pills so the two rows
                read as one visual family. Tap chip to filter; tap
                active chip to clear; tap "All genres" sentinel to
                clear from inside the strip. Any tap collapses the
                strip — the active state is preserved on the toggle
                pill above so collapsed-with-active-filter is a
                fully legible state. */}
            {genreStripOpen && availableGenres.length > 0 ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.genreScrollRow}
                    contentContainerStyle={styles.genreScrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {(() => {
                        const isAllActive = genreFilter === null;
                        return (
                            <Pressable
                                key="__all_genres"
                                onPress={() => {
                                    setGenreFilter(null);
                                    setGenreStripOpen(false);
                                }}
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isAllActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isAllActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    isAllActive
                                        ? 'All genres (current)'
                                        : 'Show all genres'
                                }
                                accessibilityState={{
                                    selected: isAllActive,
                                }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isAllActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    All genres
                                </Text>
                            </Pressable>
                        );
                    })()}
                    {availableGenres.map((g) => {
                        const isActive = genreFilter === g.id;
                        return (
                            <Pressable
                                key={g.id}
                                onPress={() => {
                                    setGenreFilter(isActive ? null : g.id);
                                    setGenreStripOpen(false);
                                }}
                                hitSlop={spacing.xs}
                                style={({ pressed }) => [
                                    styles.mediaFilterPill,
                                    {
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: isActive
                                            ? palette.accent
                                            : palette.border,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    isActive
                                        ? `Clear ${g.name} filter`
                                        : `Filter by ${g.name}`
                                }
                                accessibilityState={{ selected: isActive }}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.mediaFilterText,
                                        {
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {g.name}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            ) : null}
        </>
    );
}

const styles = StyleSheet.create({
    controlsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.sm,
        gap: spacing.sm,
    },
    mediaFilterGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    mediaFilterPill: {
        // Outlined pill when inactive, filled accent when active.
        // borderWidth always present (transparent → accent) so the
        // layout doesn't jitter as the selection moves.
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
        borderWidth: 1,
    },
    mediaFilterText: {
        fontWeight: '600',
    },
    rightControls: {
        // Sub-group on the right of controlsRow holding the Genre
        // toggle + Sort button. Sits opposite the media filter pills.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    sortButton: {
        // Right-aligned tappable cluster: icon + current sort label.
        // Tap opens the Alert.alert menu — known v1 shape; refine to
        // a proper menu/bottom-sheet later.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.xs,
    },
    sortButtonText: {
        fontWeight: '600',
    },
    genreScrollRow: {
        // Horizontal chip strip below controlsRow when revealed.
        // `flexShrink: 0` + explicit `height` are load-bearing:
        // without them the FlatList below (which has no `flex: 1`
        // and uses its intrinsic content height) competes for
        // vertical space in the parent column-flex. On a full tab
        // the FlatList wants the whole screen, the column-flex
        // shrinks every sibling with `flexShrink: 1` (the default),
        // and the ScrollView collapses — chips clip to empty
        // outlines because the contentContainer is taller than the
        // now-squeezed outer ScrollView frame. height: 36 matches
        // intrinsic content (chip lineHeight 18 + pill paddingVertical
        // 2×4 + border 2×1 = 28; plus contentContainer paddingVertical
        // 2×4 = 36). Belt-and-braces; either alone would suffice,
        // both together makes the intent obvious to future readers.
        height: 36,
        flexGrow: 0,
        flexShrink: 0,
        marginBottom: spacing.sm,
    },
    genreScrollContent: {
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.xs,
        gap: spacing.xs,
        alignItems: 'center',
    },
});
