import { Pressable, StyleSheet, View } from 'react-native';

import { getPalette, spacing } from '@/theme/theme';

// Small on/off switch (track + sliding thumb). Extracted verbatim from the
// rating sheet (its share-rating + visibility toggles) so the title page's
// "Visible to friends" row is literally the same control — one switch, one
// mental model.
export function Toggle({
    value,
    onValueChange,
    palette,
    disabled,
}: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    palette: ReturnType<typeof getPalette>;
    disabled?: boolean;
}) {
    return (
        <Pressable
            onPress={() => onValueChange(!value)}
            disabled={disabled}
            accessibilityRole="switch"
            accessibilityState={{ checked: value, disabled }}
            hitSlop={spacing.sm}
            style={[
                styles.toggleTrack,
                {
                    backgroundColor: value ? palette.accent : palette.border,
                    justifyContent: value ? 'flex-end' : 'flex-start',
                    opacity: disabled ? 0.6 : 1,
                },
            ]}
        >
            <View
                style={[
                    styles.toggleThumb,
                    { backgroundColor: palette.surface },
                ]}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    toggleTrack: {
        width: 46,
        height: 28,
        borderRadius: 14,
        padding: 2,
        flexDirection: 'row',
        alignItems: 'center',
    },
    toggleThumb: {
        width: 24,
        height: 24,
        borderRadius: 12,
    },
});
