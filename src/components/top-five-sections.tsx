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
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import type { FavoriteItem } from '@/lib/favorites';
import { imageUrl } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

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
                    typography.bodyEmphasis,
                    styles.heading,
                    { color: palette.text },
                ]}
            >
                {heading}
            </Text>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.row}
            >
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
                        <Text
                            style={[
                                typography.caption,
                                styles.cardTitle,
                                { color: palette.text },
                            ]}
                            numberOfLines={2}
                        >
                            {item.title}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    );
}

const POSTER_W = 80;
const POSTER_H = 120;

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
        paddingHorizontal: spacing.base,
        gap: spacing.md,
    },
    card: {
        width: POSTER_W,
        gap: spacing.xs,
    },
    posterWrapper: {
        position: 'relative',
    },
    poster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    rankChip: {
        position: 'absolute',
        top: spacing.xs,
        left: spacing.xs,
        width: 22,
        height: 22,
        borderRadius: radius.full,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rankText: {
        fontWeight: '700',
    },
    cardTitle: {
        textAlign: 'center',
    },
});
