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
 *      left; Genre pill + Sort icon + the grid/list view toggle on the
 *      right. When `view` is passed, the toggle expands IN PLACE on a
 *      grid-tap to reveal 2/3/4 density options while the rest of the row
 *      fades out (see the pill section below) — one control, defined here,
 *      so both library surfaces behave identically.
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

import {
    ArrowsDownUp,
    Rows,
    SquaresFour,
} from 'phosphor-react-native';
import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
    FadeIn,
    FadeOut,
    LinearTransition,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

import { Chip } from '@/components/chip';
import { SortSheet } from '@/components/sort-sheet';
import { TMDB_GENRE_NAMES } from '@/lib/genres';
import type { LibraryGridCols, LibraryMode } from '@/lib/library-view';
import {
    MEDIA_FILTERS,
    MEDIA_FILTER_LABELS,
    SORT_LABELS,
    type MediaFilter,
    type SortOption,
} from '@/lib/use-library-filters';
import {
    fontFamily,
    getPalette,
    radius,
    spacing,
} from '@/theme/theme';

type Palette = ReturnType<typeof getPalette>;

const DENSITY_OPTIONS: readonly LibraryGridCols[] = [2, 3, 4];
// Collapsed pill width (container pad 4 + two 28pt cells + 2pt gap) and the
// room the filters leave to its right for it. The expanded pill grows LEFT
// into the space the filters vacate, so this reserve only needs to fit the
// two-icon resting state.
const COLLAPSED_PILL_W = 62;
const PILL_RESERVE = COLLAPSED_PILL_W + spacing.sm;
const EXPAND_MS = 150;

interface LibraryFilterControlsProps {
    palette: Palette;
    mediaFilter: MediaFilter;
    setMediaFilter: (f: MediaFilter) => void;
    sortBy: SortOption;
    setSortBy: (s: SortOption) => void;
    // Tab-specific allowed sort options — the picker lists exactly
    // these. Comes from useLibraryFilters; the hook also enforces
    // that sortBy never lands outside this set.
    availableSortOptions: readonly SortOption[];
    genreFilter: number | null;
    setGenreFilter: (id: number | null) => void;
    genreStripOpen: boolean;
    setGenreStripOpen: (open: boolean) => void;
    availableGenres: Array<{ id: number; name: string }>;
    // Library view state + setters. When passed, the grid/list toggle (and
    // its expand-in-place density options) render at the right of the filter
    // row. Both library surfaces pass it, so the control is identical on each
    // by construction. Omitted → no toggle.
    view?: {
        mode: LibraryMode;
        gridCols: LibraryGridCols;
        setMode: (m: LibraryMode) => void;
        setGridCols: (n: LibraryGridCols) => void;
    };
}

export function LibraryFilterControls({
    palette,
    mediaFilter,
    setMediaFilter,
    sortBy,
    setSortBy,
    availableSortOptions,
    genreFilter,
    setGenreFilter,
    genreStripOpen,
    setGenreStripOpen,
    availableGenres,
    view,
}: LibraryFilterControlsProps) {
    // Sort picker: the app's own bottom sheet (SortSheet), same pattern as
    // WatchersSheet/RatingSheet, on BOTH platforms. Replaces two failed
    // native attempts: Alert.alert (Cancel indistinguishable from the
    // options) and ActionSheetIOS (presented as a centered popover with NO
    // Cancel on a plain iPhone). One cross-platform code path, and the
    // custom sheet is what the A16/Android build will get too.
    const [sortSheetOpen, setSortSheetOpen] = useState(false);

    // Density options expanded in place on the toggle. Only ever true in grid
    // mode (see handleGrid). The filter group cross-fades out while it's true.
    const [densityExpanded, setDensityExpanded] = useState(false);
    const filtersOpacity = useSharedValue(1);
    useEffect(() => {
        filtersOpacity.value = withTiming(densityExpanded ? 0 : 1, {
            duration: EXPAND_MS,
        });
    }, [densityExpanded, filtersOpacity]);
    const filtersAnimStyle = useAnimatedStyle(() => ({
        opacity: filtersOpacity.value,
    }));

    const handleList = () => {
        if (!view) return;
        // Switch to list; there's nothing to configure in list mode, so any
        // open density options collapse.
        view.setMode('list');
        setDensityExpanded(false);
    };

    const handleGrid = () => {
        if (!view) return;
        if (densityExpanded) {
            // Escape hatch — collapse WITHOUT changing anything, and
            // DELIBERATELY stay in grid at the current density. The density
            // options were an offer, not a requirement: the user asked for
            // grid and got grid; tapping grid again just dismisses the offer.
            // Do NOT "fix" this into reverting to list — that would punish an
            // accidental open by forcing a choice, and would drop the grid
            // mode the user explicitly selected. This asymmetry is intended.
            setDensityExpanded(false);
            return;
        }
        // Collapsed grid tap: enter grid if not already (from list this is
        // switch-to-grid AND expand in one tap — the moment density is most
        // relevant, and how the control is discovered at all), then reveal
        // the density options.
        if (view.mode !== 'grid') view.setMode('grid');
        setDensityExpanded(true);
    };

    const handleDensity = (n: LibraryGridCols) => {
        if (!view) return;
        view.setGridCols(n);
        setDensityExpanded(false);
    };

    return (
        <>
            <View style={styles.controlsRow}>
                {/* Filter group — media / genre / sort. Fades out (and goes
                    untappable) while the density options are expanded, to make
                    room for the pill growing over it. paddingRight reserves the
                    collapsed pill's slot so genre/sort don't sit under it. */}
                <Animated.View
                    style={[
                        styles.filtersGroup,
                        view ? styles.filtersReserve : null,
                        filtersAnimStyle,
                    ]}
                    pointerEvents={densityExpanded ? 'none' : 'auto'}
                >
                    <View style={styles.mediaFilterGroup}>
                        {MEDIA_FILTERS.map((opt) => (
                            <Chip
                                key={opt}
                                label={MEDIA_FILTER_LABELS[opt]}
                                active={mediaFilter === opt}
                                onPress={() => setMediaFilter(opt)}
                            />
                        ))}
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
                                <Chip
                                    label={activeGenreLabel ?? 'Genre'}
                                    active={isGenreActive}
                                    expanded={genreStripOpen}
                                    onPress={() =>
                                        setGenreStripOpen(!genreStripOpen)
                                    }
                                    accessibilityLabel={
                                        isGenreActive
                                            ? `Genre filter: ${activeGenreLabel}. Tap to ${genreStripOpen ? 'hide' : 'show'} options.`
                                            : `${genreStripOpen ? 'Hide' : 'Show'} genre options`
                                    }
                                    // Cap the pill so a long active genre
                                    // ("Action & Adventure" ≈ 150pt) can't push
                                    // the collapsed row past the 343pt available
                                    // at 375. Short genres fit in full; long
                                    // ones ellipsize (full name via the strip).
                                    numberOfLines={1}
                                    style={styles.genrePill}
                                />
                            );
                        })()}
                        {/* Sort trigger — icon only. The label was redundant:
                            the sort sheet names the current option when opened.
                            Neutral (palette.text), not an accent/selected state
                            — sort is a trigger, not a filter. */}
                        <Pressable
                            onPress={() => setSortSheetOpen(true)}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [
                                styles.sortButton,
                                pressed && { opacity: 0.6 },
                            ]}
                            accessibilityLabel={`Sort by ${SORT_LABELS[sortBy]}`}
                            accessibilityRole="button"
                        >
                            <ArrowsDownUp
                                color={palette.text}
                                size={18}
                            />
                        </Pressable>
                    </View>
                </Animated.View>

                {/* Grid/list toggle, right-anchored so it grows LEFT on expand
                    — the mode icons never move, so the icon you just tapped
                    stays under your thumb. Absolute so its growth never
                    reflows or clips the fading filter group. The anchor spans
                    the chip band (top 0 → bottom paddingBottom) and centres the
                    pill vertically. */}
                {view ? (
                    <View style={styles.pillAnchor} pointerEvents="box-none">
                        <Animated.View
                            layout={LinearTransition.duration(EXPAND_MS)}
                            style={[
                                styles.pill,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                        >
                            {densityExpanded ? (
                                <Animated.View
                                    entering={FadeIn.duration(EXPAND_MS)}
                                    exiting={FadeOut.duration(EXPAND_MS - 20)}
                                    style={styles.densityGroup}
                                >
                                    {DENSITY_OPTIONS.map((opt) => (
                                        <ToggleCell
                                            key={opt}
                                            active={view.gridCols === opt}
                                            palette={palette}
                                            onPress={() => handleDensity(opt)}
                                            accessibilityLabel={`${opt} columns`}
                                        >
                                            <Text
                                                style={[
                                                    styles.densityNumber,
                                                    {
                                                        color:
                                                            view.gridCols === opt
                                                                ? palette.accent
                                                                : palette.textMuted,
                                                    },
                                                ]}
                                            >
                                                {opt}
                                            </Text>
                                        </ToggleCell>
                                    ))}
                                </Animated.View>
                            ) : null}
                            <View style={styles.modeGroup}>
                                <ToggleCell
                                    active={view.mode === 'list'}
                                    palette={palette}
                                    onPress={handleList}
                                    accessibilityLabel="List view"
                                >
                                    <Rows
                                        color={
                                            view.mode === 'list'
                                                ? palette.accent
                                                : palette.textMuted
                                        }
                                        size={18}
                                    />
                                </ToggleCell>
                                <ToggleCell
                                    active={view.mode === 'grid'}
                                    palette={palette}
                                    onPress={handleGrid}
                                    accessibilityLabel={
                                        view.mode === 'grid'
                                            ? densityExpanded
                                                ? 'Grid view. Hide column options.'
                                                : `Grid view, ${view.gridCols} columns. Show column options.`
                                            : 'Grid view'
                                    }
                                >
                                    <SquaresFour
                                        color={
                                            view.mode === 'grid'
                                                ? palette.accent
                                                : palette.textMuted
                                        }
                                        size={18}
                                    />
                                </ToggleCell>
                            </View>
                        </Animated.View>
                    </View>
                ) : null}
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
                            <Chip
                                key="__all_genres"
                                label="All genres"
                                active={isAllActive}
                                onPress={() => {
                                    setGenreFilter(null);
                                    setGenreStripOpen(false);
                                }}
                                accessibilityLabel={
                                    isAllActive
                                        ? 'All genres (current)'
                                        : 'Show all genres'
                                }
                            />
                        );
                    })()}
                    {availableGenres.map((g) => {
                        const isActive = genreFilter === g.id;
                        return (
                            <Chip
                                key={g.id}
                                label={g.name}
                                active={isActive}
                                onPress={() => {
                                    setGenreFilter(isActive ? null : g.id);
                                    setGenreStripOpen(false);
                                }}
                                accessibilityLabel={
                                    isActive
                                        ? `Clear ${g.name} filter`
                                        : `Filter by ${g.name}`
                                }
                            />
                        );
                    })}
                </ScrollView>
            ) : null}

            <SortSheet
                visible={sortSheetOpen}
                options={availableSortOptions.map((opt) => ({
                    value: opt,
                    label: SORT_LABELS[opt],
                }))}
                selectedValue={sortBy}
                onSelect={(value) => {
                    setSortBy(value);
                    setSortSheetOpen(false);
                }}
                onClose={() => setSortSheetOpen(false)}
            />
        </>
    );
}

// Cell shared by the mode toggle and the density options — a plum WASH FILL
// for the active state, matching the filter chips and the segmented control
// so every "selected" state across the filter zone speaks one language. No
// border; the fill carries "selected". Constant min size so the fill swapping
// in/out causes no layout shift.
function ToggleCell({
    active,
    onPress,
    palette,
    accessibilityLabel,
    children,
}: {
    active: boolean;
    onPress: () => void;
    palette: Palette;
    accessibilityLabel: string;
    children: ReactNode;
}) {
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.xs}
            style={({ pressed }) => [
                styles.toggleCell,
                {
                    backgroundColor: active
                        ? palette.accentWash
                        : 'transparent',
                },
                pressed && { opacity: 0.6 },
            ]}
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
        >
            {children}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    controlsRow: {
        // Relative host for the fading filter group + the absolute,
        // right-anchored view-toggle pill.
        position: 'relative',
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.sm,
    },
    filtersGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
    },
    filtersReserve: {
        // Leave the collapsed pill's slot free at the right so genre/sort
        // don't sit beneath it. Only applied when the toggle is present.
        paddingRight: PILL_RESERVE,
    },
    mediaFilterGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    rightControls: {
        // Genre pill + Sort icon. Sits opposite the media filter pills.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    genrePill: {
        // Width cap so a long active genre can't overflow the collapsed row —
        // see the numberOfLines note at the call site.
        maxWidth: 72,
    },
    sortButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xs,
    },
    pillAnchor: {
        // Spans the chip band (top 0 → bottom = controlsRow paddingBottom) and
        // centres the pill vertically. Right-pinned with no width, so it hugs
        // the pill and the pill's right edge stays put as it grows left.
        position: 'absolute',
        top: 0,
        bottom: spacing.sm,
        right: spacing.base,
        justifyContent: 'center',
    },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: radius.sm,
        padding: spacing.xxs,
        gap: spacing.xs,
    },
    densityGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xxs,
    },
    modeGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xxs,
    },
    toggleCell: {
        minWidth: 28,
        minHeight: 26,
        paddingHorizontal: spacing.xs,
        paddingVertical: spacing.xxs,
        borderRadius: radius.sm - 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    densityNumber: {
        fontSize: 12,
        fontFamily: fontFamily.bold,
        lineHeight: 16,
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
