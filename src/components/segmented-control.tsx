// Generic segmented control: one rounded container holding N options,
// the selected one filled (subtle accent wash), the rest plain. Used
// for library + friend-library's Watchlist/Watching/Watched picker;
// usable for any string-valued mutually-exclusive choice.
//
// Visual posture:
//   - Container: palette.surface (a step lighter than the surfaceAlt
//     zone we sit in), radius.md outer corners, internal spacing.xs
//     padding so the selected segment is inset from the container edge.
//   - Selected segment: palette.accentWash (the shared filter-zone
//     selected fill — same token the chips + grid selector use) +
//     palette.accent text bumped to semibold — a confident wash that
//     reads clearly in the white container, but deliberately NOT a
//     solid-accent fill or an outline (a segmented control suits a
//     fill; solid accent is reserved for nav/buttons).
//   - Unselected segments: transparent background + palette.textMuted
//     text — read as inactive but tappable.
//   - Labels at 14/Medium (caption size + medium weight) — reads as a
//     control rather than a body-sized button.
//   - Generous tap target: paddingVertical spacing.md gives ~42pt
//     total height, right at the Apple minimum.
//
// Generic over T (string-valued) so the caller's option list keeps
// its narrowed type through the onChange callback — no string cast at
// the call site.

import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import {
    fontFamily,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type Palette = ReturnType<typeof getPalette>;

interface SegmentedControlProps<T extends string> {
    options: ReadonlyArray<{ value: T; label: string }>;
    value: T;
    onChange: (next: T) => void;
    palette: Palette;
}

export function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    palette,
}: SegmentedControlProps<T>) {
    return (
        <View
            style={[
                styles.container,
                { backgroundColor: palette.surface },
            ]}
        >
            {options.map((option) => {
                const isActive = option.value === value;
                return (
                    <Pressable
                        key={option.value}
                        onPress={() => onChange(option.value)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: isActive }}
                        accessibilityLabel={option.label}
                        style={({ pressed }) => [
                            styles.segment,
                            {
                                backgroundColor: isActive
                                    ? palette.accentWash
                                    : 'transparent',
                                opacity: pressed ? 0.7 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                styles.label,
                                {
                                    color: isActive
                                        ? palette.accent
                                        : palette.textMuted,
                                    // Selected segment bumps to semibold
                                    // for extra confidence on top of the
                                    // deeper accentWash fill; inactive
                                    // stays medium (set in styles.label).
                                    fontFamily: isActive
                                        ? fontFamily.semibold
                                        : fontFamily.medium,
                                },
                            ]}
                        >
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        // Borderless — the surface fill against the zone behind it is the
        // separation (same posture as the borderless search pills). The
        // selected segment needs no outline either: its accentWash fill on
        // the white container carries the distinction on its own.
        flexDirection: 'row',
        padding: spacing.xs,
        borderRadius: radius.md,
        // gap so the selected segment's fill doesn't touch its siblings;
        // combined with the container padding, the segment sits as a
        // distinct pill inside the rounded container.
        gap: spacing.xs,
    },
    segment: {
        flex: 1,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        // caption size (14px) at medium (500) weight. Reads as a
        // control label rather than a body button (which would use
        // bodyEmphasis at 16/600 — too shouty for a segmented control).
        ...typography.caption,
        fontFamily: fontFamily.medium,
    },
});
