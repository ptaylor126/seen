/**
 * Chip — the canonical filter / selection pill used across the app's
 * library-shaped surfaces: the Library media filters (All / Movies / TV), the
 * Genre toggle + genre chips, and the Friends sort chips.
 *
 * One look, defined once here (geometry from the `chip` theme token, colours
 * from the palette), so the two rows read as one visual family and can't drift:
 *   - selected   → accentWash fill, no border (transparent, keeps the same
 *                  hairline box so there's no layout shift), accent text.
 *   - unselected → transparent fill, palette.border outline, textMuted text.
 * The border width is constant across states — only its colour changes.
 *
 * Label-only by design (no icon slot) — every current chip is a text pill. The
 * `expanded` prop is purely for accessibility on toggle-style chips (e.g. the
 * Genre toggle that reveals a strip); it doesn't change the visuals.
 */

import {
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import {
    chip as chipTokens,
    fontFamily,
    getPalette,
    spacing,
    typography,
} from '@/theme/theme';

export function Chip({
    label,
    active,
    onPress,
    accessibilityLabel,
    expanded,
    hitSlop = spacing.xs,
    style,
    numberOfLines,
}: {
    label: string;
    active: boolean;
    onPress: () => void;
    // Defaults to `label`; pass a fuller sentence for toggle chips.
    accessibilityLabel?: string;
    // Toggle chips only (e.g. Genre strip open/closed) — a11y state, not visual.
    expanded?: boolean;
    hitSlop?: number;
    style?: StyleProp<ViewStyle>;
    // Truncate the label to N lines with an ellipsis. Used by the Genre pill,
    // which is width-capped so a long active genre can't overflow the filter
    // row; pair with a maxWidth in `style`.
    numberOfLines?: number;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    return (
        <Pressable
            onPress={onPress}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityState={{ selected: active, expanded }}
            accessibilityLabel={accessibilityLabel ?? label}
            style={({ pressed }) => [
                styles.chip,
                {
                    backgroundColor: active ? palette.accentWash : 'transparent',
                    borderColor: active ? 'transparent' : palette.border,
                    opacity: pressed ? 0.6 : 1,
                },
                style,
            ]}
        >
            <Text
                style={[
                    styles.label,
                    { color: active ? palette.accent : palette.textMuted },
                ]}
                numberOfLines={numberOfLines}
            >
                {label}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    chip: {
        paddingHorizontal: chipTokens.paddingHorizontal,
        paddingVertical: chipTokens.paddingVertical,
        borderRadius: chipTokens.borderRadius,
        borderWidth: chipTokens.borderWidth,
    },
    label: {
        // 14/Medium — matches the SegmentedControl label treatment so the
        // whole filter zone reads with one typographic voice.
        ...typography.caption,
        fontFamily: fontFamily.medium,
    },
});
