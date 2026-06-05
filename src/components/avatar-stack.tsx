import { useColorScheme, View, StyleSheet, Text } from 'react-native';

import { Avatar } from '@/components/avatar';
import { getPalette, typography } from '@/theme/theme';

export interface AvatarStackItem {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
}

interface AvatarStackProps {
    items: AvatarStackItem[];
    /** Max avatars to render before collapsing the rest into a +N chip. */
    limit: number;
    /** Avatar diameter in px. */
    size: number;
    /** Horizontal overlap between adjacent chips in px. Tune to size:
     *  ~60% of size reads as "stack" without obscuring the next face. */
    overlap: number;
    /** Border colour used to separate adjacent overlapping chips —
     *  pass the surface colour behind the stack so the chips read as
     *  cleanly cut-out, not bordered. */
    borderColor: string;
}

// Stacked-avatar social proof. Render order is left-to-right
// (front-of-stack = last drawn = rightmost): the first item in
// `items` sits rightmost and on top, with subsequent items tucked
// behind to the left, and the +N chip (when items.length > limit)
// sits leftmost. Each non-first chip overlaps its predecessor via a
// negative marginLeft.
//
// NOTE: the Home tab's "Friends are watching" grid uses the same
// visual treatment but renders its stack inline because that block
// also positions the stack absolutely within a poster cell — a
// quirk that doesn't generalise. Migrating the Home grid to this
// component is mechanical but deliberately out of scope here.
export function AvatarStack({
    items,
    limit,
    size,
    overlap,
    borderColor,
}: AvatarStackProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    if (items.length === 0) return null;

    const shown = items.slice(0, limit);
    const extra = items.length - shown.length;
    // Chips are size + 2*chipBorderWidth wide so the border doesn't eat
    // into the avatar circle. 2px is enough to read as a clean cut at
    // the small sizes we use this at; bigger borders look chunky.
    const chipBorderWidth = 2;
    const chipSize = size + chipBorderWidth * 2;
    const chipBorderRadius = chipSize / 2;

    return (
        <View style={styles.row}>
            {extra > 0 ? (
                <View
                    style={[
                        styles.chip,
                        {
                            width: chipSize,
                            height: chipSize,
                            borderRadius: chipBorderRadius,
                            borderWidth: chipBorderWidth,
                            borderColor,
                            backgroundColor: palette.accent,
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.micro,
                            { color: palette.textInverse },
                        ]}
                    >
                        +{extra}
                    </Text>
                </View>
            ) : null}
            {shown
                .slice()
                .reverse()
                .map((item, idx) => {
                    const isLeftmost = idx === 0 && extra === 0;
                    return (
                        <View
                            key={item.userId}
                            style={[
                                styles.chip,
                                {
                                    width: chipSize,
                                    height: chipSize,
                                    borderRadius: chipBorderRadius,
                                    borderWidth: chipBorderWidth,
                                    borderColor,
                                },
                                !isLeftmost && { marginLeft: -overlap },
                            ]}
                        >
                            <Avatar
                                avatarUrl={item.avatarUrl}
                                displayName={item.displayName}
                                seedId={item.userId}
                                size={size}
                            />
                        </View>
                    );
                })}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    chip: {
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
});
