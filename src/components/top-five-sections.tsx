// Read-only "Top 5 Films" / "Top 5 Shows" sections shared between the
// own profile screen and the friend profile screen. Visual treatment
// is deliberately minimal — this gets a proper design pass once the
// editor lands; for now we just render whatever's in the favorites
// table.
//
// Empty handling: a section is omitted entirely when its array is
// empty (no "—" placeholder slots, no "No top 5 yet" copy). Layer 3
// (the editor) will introduce a "Tap to add" affordance on the owner's
// own profile; for now the absence of content is the only signal.
// Both sections empty → the component returns null and adds nothing
// to the parent layout.

import { Image } from 'expo-image';
import {
    Dimensions,
    Pressable,
    StyleSheet,
    View,
} from 'react-native';

import { Text } from '@/components/text';
import type { FavoriteItem } from '@/lib/favorites';
import { imageUrl } from '@/lib/tmdb';
import { fontFamily, posterFrame, getPalette, radius, spacing, typography } from '@/theme/theme';

type Palette = ReturnType<typeof getPalette>;

interface TopFiveSectionsProps {
    movies: FavoriteItem[];
    tv: FavoriteItem[];
    onSelect: (mediaType: 'movie' | 'tv', tmdbId: number) => void;
    palette: Palette;
}

export function TopFiveSections({
    movies,
    tv,
    onSelect,
    palette,
}: TopFiveSectionsProps) {
    if (movies.length === 0 && tv.length === 0) return null;
    return (
        <View style={styles.container}>
            {movies.length > 0 && (
                <Section
                    heading="Top 5 Films"
                    items={movies}
                    onSelect={onSelect}
                    palette={palette}
                />
            )}
            {tv.length > 0 && (
                <Section
                    heading="Top 5 Shows"
                    items={tv}
                    onSelect={onSelect}
                    palette={palette}
                />
            )}
        </View>
    );
}

function Section({
    heading,
    items,
    onSelect,
    palette,
}: {
    heading: string;
    items: FavoriteItem[];
    onSelect: (mediaType: 'movie' | 'tv', tmdbId: number) => void;
    palette: Palette;
}) {
    return (
        <View style={styles.section}>
            <Text
                style={[
                    typography.overline,
                    styles.heading,
                    { color: palette.textMuted },
                ]}
            >
                {heading}
            </Text>
            {/* Non-scrolling row: all 5 posters fit the screen width
                (POSTER_W computed below). No labels under the posters —
                the artwork is recognisable on its own. */}
            <View style={styles.row}>
                {items.map((item) => (
                    <Pressable
                        key={`${item.mediaType}:${item.tmdbId}`}
                        onPress={() => onSelect(item.mediaType, item.tmdbId)}
                        accessibilityRole="link"
                        accessibilityLabel={
                            item.title
                                ? `Rank ${item.rank}: ${item.title}`
                                : `Rank ${item.rank}`
                        }
                        style={({ pressed }) => [
                            styles.card,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <View style={styles.posterWrapper}>
                            {item.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(item.posterPath, 'w185'),
                                    }}
                                    style={styles.poster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.poster,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <View
                                style={[
                                    styles.rankChip,
                                    {
                                        backgroundColor: palette.bg,
                                        borderColor: palette.border,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.micro,
                                        styles.rankText,
                                        { color: palette.text },
                                    ]}
                                >
                                    {item.rank}
                                </Text>
                            </View>
                        </View>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

// Fit all 5 posters across the screen width: 5 posters + 4 inter-poster
// gaps inside the row's horizontal padding. Math.floor so sub-pixel
// rounding never overflows the row (an overflow would wrap the 5th
// poster onto a second line). 2:3 aspect preserved (H = W * 1.5).
const SCREEN_W = Dimensions.get('window').width;
const H_PADDING = spacing.base;
const POSTER_GAP = spacing.sm;
const POSTER_W = Math.floor((SCREEN_W - 2 * H_PADDING - 4 * POSTER_GAP) / 5);
const POSTER_H = Math.round(POSTER_W * 1.5);

const styles = StyleSheet.create({
    container: {
        gap: spacing.md,
    },
    section: {
        gap: spacing.sm,
    },
    heading: {
        paddingHorizontal: spacing.base,
    },
    row: {
        flexDirection: 'row',
        paddingHorizontal: H_PADDING,
        gap: POSTER_GAP,
    },
    card: {
        width: POSTER_W,
    },
    posterWrapper: {
        position: 'relative',
    },
    poster: {
        ...posterFrame,
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    rankChip: {
        position: 'absolute',
        top: spacing.xs,
        left: spacing.xs,
        // min, not fixed: the rank digit scales with OS font settings (to
        // the app-wide 1.3 clamp) and must grow the circle, not clip.
        minWidth: 22,
        minHeight: 22,
        borderRadius: radius.full,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rankText: {
        fontFamily: fontFamily.bold,
    },
});
