import { LayoutGrid, LayoutList } from 'lucide-react-native';
import { useRef, type ReactNode } from 'react';
import {
    Pressable,
    StyleSheet,
    type StyleProp,
    Text,
    View,
    type ViewStyle,
} from 'react-native';
import Animated, {
    FadeIn,
    FadeOut,
    LinearTransition,
} from 'react-native-reanimated';

import type { LibraryGridCols, LibraryMode } from '@/lib/library-view';
import { getPalette, ICON_STROKE_WIDTH, radius, spacing } from '@/theme/theme';

type Palette = ReturnType<typeof getPalette>;

// list/grid toggle + (when grid is active) 2/3/4 density picker. Reads
// + writes the persisted global library-view setting via the caller-
// supplied handlers, so flipping mode on one library surface (own tab,
// friend profile) propagates to every other.
export function ViewControls({
    mode,
    gridCols,
    onModeChange,
    onGridColsChange,
    palette,
}: {
    mode: LibraryMode;
    gridCols: LibraryGridCols;
    onModeChange: (next: LibraryMode) => void;
    onGridColsChange: (next: LibraryGridCols) => void;
    palette: Palette;
}) {
    const densityOptions: LibraryGridCols[] = [2, 3, 4];
    // Only animate in response to a real user toggle — never on mount or
    // on the async AsyncStorage hydration. useLibraryView starts on the
    // 'list' default, then a moment later setView() flips to the
    // persisted mode; that post-mount list→grid flip is hydration, not a
    // user action, and is what was sliding the controls in from the
    // top-right on load. `interacted` flips true ONLY inside the press
    // handlers below, so hydration-driven changes render statically while
    // genuine toggles animate. (A "has mounted" flag can't distinguish
    // the two — the hydration flip happens after mount.)
    const interacted = useRef(false);
    const handleModeChange = (next: LibraryMode) => {
        interacted.current = true;
        onModeChange(next);
    };
    const handleGridColsChange = (next: LibraryGridCols) => {
        interacted.current = true;
        onGridColsChange(next);
    };
    return (
        // LinearTransition animates the container's width on density
        // mount/unmount so the toggle doesn't pop sideways — gated on
        // `interacted` so it only runs after a user toggle, not on the
        // initial hydration. Reanimated rather than LayoutAnimation
        // because the latter silently no-ops for mount/unmount on the
        // New Architecture (Fabric, default in Expo SDK 54).
        <Animated.View
            layout={
                interacted.current ? LinearTransition.duration(180) : undefined
            }
            style={[styles.viewControls, { backgroundColor: palette.surfaceAlt }]}
        >
            <View style={styles.toggleGroup}>
                <ViewControlsCell
                    active={mode === 'list'}
                    onPress={() => handleModeChange('list')}
                    palette={palette}
                    accessibilityLabel="List view"
                >
                    <LayoutList
                        color={
                            mode === 'list' ? palette.accent : palette.textMuted
                        }
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </ViewControlsCell>
                <ViewControlsCell
                    active={mode === 'grid'}
                    onPress={() => handleModeChange('grid')}
                    palette={palette}
                    accessibilityLabel="Grid view"
                >
                    <LayoutGrid
                        color={
                            mode === 'grid' ? palette.accent : palette.textMuted
                        }
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </ViewControlsCell>
            </View>
            {mode === 'grid' ? (
                // Density group fades in/out as one cohesive unit so the
                // three numbers read as a single control appearing,
                // rather than three staggered cells popping in. `entering`
                // is gated on `interacted` so it only plays on a user-
                // initiated list→grid toggle — never on mount or on the
                // hydration flip (if the screen loads already in grid
                // mode the picker just appears, no animation). `exiting`
                // is always kept — it can only fire on a real grid→list
                // unmount, which is always user-initiated.
                <Animated.View
                    style={styles.densityGroup}
                    entering={
                        interacted.current ? FadeIn.duration(180) : undefined
                    }
                    exiting={FadeOut.duration(140)}
                >
                    {densityOptions.map((opt) => {
                        const isActive = gridCols === opt;
                        return (
                            <ViewControlsCell
                                key={opt}
                                active={isActive}
                                onPress={() => handleGridColsChange(opt)}
                                palette={palette}
                                accessibilityLabel={`${opt} columns`}
                                cellStyle={styles.densityCell}
                            >
                                <Text
                                    style={[
                                        styles.controlsNumber,
                                        {
                                            color: isActive
                                                ? palette.accent
                                                : palette.textMuted,
                                        },
                                    ]}
                                >
                                    {opt}
                                </Text>
                            </ViewControlsCell>
                        );
                    })}
                </Animated.View>
            ) : null}
        </Animated.View>
    );
}

// Cell shared by both control types in the cluster (list/grid toggle +
// 2/3/4 density). One treatment for all of them — a plum WASH FILL,
// matching the All/Movies/TV filter chips and the segmented control so
// every "selected" state across the filter zone speaks the same
// language (the wash fill, not an outline):
//   - active   = palette.accentWash fill (the shared filter-zone
//     selected fill — exactly what the chips + segmented control use) +
//     the caller passes palette.accent as the content (icon/text) color.
//   - inactive = transparent fill, no border; the caller passes
//     palette.textMuted as the content color.
// No border in either state — the fill carries "selected". minHeight is
// constant so toggle and density cells sit level in the row, and the
// fill swapping in/out causes no layout shift. The two control types
// are differentiated by their CONTENT (icons vs numbers), so they don't
// need different selected-styles on top.
function ViewControlsCell({
    active,
    onPress,
    palette,
    accessibilityLabel,
    cellStyle,
    children,
}: {
    active: boolean;
    onPress: () => void;
    palette: Palette;
    accessibilityLabel: string;
    cellStyle?: StyleProp<ViewStyle>;
    children: ReactNode;
}) {
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.xs}
            style={({ pressed }) => [
                styles.controlsCell,
                cellStyle,
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
    viewControls: {
        // Single shared container behind the whole list/grid + density
        // cluster so the controls read as one connected unit. 2pt
        // padding gives the cells a small breath against the rounded
        // outer edge. Gap is the visible separation between the toggle
        // group and the density group when both are present.
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: radius.sm,
        padding: 2,
        gap: spacing.xs,
    },
    toggleGroup: {
        // Tight pair — list and grid are two states of one decision, so
        // they sit flush together with just a hairline of padding.
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    densityGroup: {
        // Wider gap so the three numeric options read as distinct
        // discrete buttons, not a single block.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    controlsCell: {
        // Constant min size so toggle and density cells sit level; the
        // active state is a plum wash fill (set inline), no border, so
        // there's no layout shift as selection moves. radius.sm - 2
        // gives a slightly tighter corner than the surrounding container
        // so the filled cell nests cleanly inside it.
        minWidth: 28,
        minHeight: 26,
        paddingHorizontal: spacing.xs,
        paddingVertical: 2,
        borderRadius: radius.sm - 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    densityCell: {
        // Extra horizontal breathing room so the single-digit number
        // doesn't read as cramped inside its border.
        paddingHorizontal: spacing.sm,
    },
    controlsNumber: {
        // Slightly smaller than the previous 14pt / 600 — reads as a
        // label rather than competing with the toggle icons for weight.
        fontSize: 12,
        fontWeight: '700',
        lineHeight: 16,
    },
});
