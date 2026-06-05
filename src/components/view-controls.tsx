import { LayoutGrid, LayoutList } from 'lucide-react-native';
import type { ReactNode } from 'react';
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
    return (
        // LinearTransition animates the container's width on density
        // mount/unmount so the toggle doesn't pop sideways. Reanimated
        // is used here rather than LayoutAnimation because the latter
        // silently no-ops for mount/unmount on the New Architecture
        // (Fabric, which Expo SDK 54 turns on by default) — that's why
        // the previous LayoutAnimation attempt was invisible.
        <Animated.View
            layout={LinearTransition.duration(180)}
            style={[styles.viewControls, { backgroundColor: palette.surfaceAlt }]}
        >
            <View style={styles.toggleGroup}>
                <ViewControlsCell
                    active={mode === 'list'}
                    variant="fill"
                    onPress={() => onModeChange('list')}
                    palette={palette}
                    accessibilityLabel="List view"
                >
                    <LayoutList
                        color={
                            mode === 'list' ? palette.textInverse : palette.text
                        }
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </ViewControlsCell>
                <ViewControlsCell
                    active={mode === 'grid'}
                    variant="fill"
                    onPress={() => onModeChange('grid')}
                    palette={palette}
                    accessibilityLabel="Grid view"
                >
                    <LayoutGrid
                        color={
                            mode === 'grid' ? palette.textInverse : palette.text
                        }
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </ViewControlsCell>
            </View>
            {mode === 'grid' ? (
                // Density group fades in/out as one cohesive unit so the
                // three numbers read as a single control appearing,
                // rather than three staggered cells popping in.
                <Animated.View
                    style={styles.densityGroup}
                    entering={FadeIn.duration(180)}
                    exiting={FadeOut.duration(140)}
                >
                    {densityOptions.map((opt) => {
                        const isActive = gridCols === opt;
                        return (
                            <ViewControlsCell
                                key={opt}
                                active={isActive}
                                variant="stroke"
                                onPress={() => onGridColsChange(opt)}
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
                                                : palette.text,
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

// Cell shared between the two control types in the cluster. Both
// variants keep `borderWidth: 1.5` and the same `minHeight` so toggle
// and density cells sit level in the row regardless of which active
// treatment they carry.
//   - `variant: 'fill'`: active = solid accent fill, inactive = no
//     visible chrome. Border is always transparent.
//   - `variant: 'stroke'`: active = coral outline, inactive = no
//     visible chrome. Background is always transparent.
// Caller passes the content color (icon/text) to match.
function ViewControlsCell({
    active,
    variant,
    onPress,
    palette,
    accessibilityLabel,
    cellStyle,
    children,
}: {
    active: boolean;
    variant: 'fill' | 'stroke';
    onPress: () => void;
    palette: Palette;
    accessibilityLabel: string;
    cellStyle?: StyleProp<ViewStyle>;
    children: ReactNode;
}) {
    const variantStyle =
        variant === 'fill'
            ? {
                  backgroundColor: active ? palette.accent : 'transparent',
                  borderColor: 'transparent',
              }
            : {
                  backgroundColor: 'transparent',
                  borderColor: active ? palette.accent : 'transparent',
              };
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.xs}
            style={({ pressed }) => [
                styles.controlsCell,
                cellStyle,
                variantStyle,
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
        // Same height in every variant so the filled toggle and the
        // stroked numbers sit perfectly level in the row. borderWidth
        // is always present (transparent when inactive in the stroke
        // variant, always transparent in the fill variant) to keep
        // layout stable as selection moves.
        minWidth: 28,
        minHeight: 26,
        paddingHorizontal: spacing.xs,
        paddingVertical: 2,
        borderRadius: radius.sm - 2,
        borderWidth: 1.5,
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
