import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    Alert,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    FullScreenLoader,
    useDeferredLoading,
} from '@/components/full-screen-loader';
import { LoadError } from '@/components/load-error';
import { OnboardingProgress } from '@/components/onboarding-progress';
import {
    setOnboardingItemStatus,
    type OnboardingTitle,
} from '@/lib/onboarding-utils';
import { type MediaType } from '@/lib/rating';
import {
    discoverByGenre,
    getPopular,
    getTopRated,
    getTrending,
    imageUrl,
    type TMDBMovieSummary,
    type TMDBSearchResult,
    type TMDBTVSummary,
} from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// ---------------------------------------------------------------------------
// Tunable blend config — adjust these freely; the compose logic below reads
// them, so ratios + tile count change in one place without touching logic.
// ---------------------------------------------------------------------------
const TILE_COUNT = 120; // total tiles shown
// Pages pulled per source. One page (20 results) can't fill ~120 tiles after
// de-dupe + poster-filter, so we fetch several per source and tolerate per-page
// failures. Tunable; cost is 8 sources × this many proxy calls per load.
const PAGES_PER_SOURCE = 3;
const MOVIE_SHARE = 0.6; // 60% movies / 40% TV
// Per-content-source share of the grid (sums to ~1).
const SOURCE_MIX = {
    trending: 0.25,
    popular: 0.3,
    topRated: 0.25,
    discover: 0.2,
} as const;
// Discover genres (TMDB ids) for category spread; comma-joined = OR-match.
// Action, Comedy, Drama, Sci-Fi, Animation.
const DISCOVER_GENRES = [28, 35, 18, 878, 16];
// Below this many usable tiles → show the friendly fallback instead of a sad,
// half-empty grid.
const MIN_TILES_TO_RENDER = 9;
const NUM_COLUMNS = 3;

type SourceKey = keyof typeof SOURCE_MIX;

interface Tile {
    key: string; // `${mediaType}:${tmdbId}` — also the de-dupe key
    poster: string; // guaranteed non-null poster path (filtered)
    title: OnboardingTitle; // payload for the shared write
}

// Map a list-result summary to a Tile, STAMPING media_type from the source
// call. Critical: popular/top_rated/discover responses don't carry media_type
// per item, and the items upsert depends on it — so `media` (the source of
// truth for the call) is what we tag, never a field read off the item.
function summaryToTile(
    item: TMDBMovieSummary | TMDBTVSummary,
    media: MediaType,
): Tile | null {
    if (!item.poster_path) return null;
    const isMovie = media === 'movie';
    // Field names differ by media (title/name, release_date/first_air_date);
    // narrow via `media` since the union isn't discriminated here.
    const name = isMovie
        ? (item as TMDBMovieSummary).title
        : (item as TMDBTVSummary).name;
    const rawDate = isMovie
        ? (item as TMDBMovieSummary).release_date
        : (item as TMDBTVSummary).first_air_date;
    return {
        key: `${media}:${item.id}`,
        poster: item.poster_path,
        title: {
            tmdbId: item.id,
            mediaType: media,
            title: name,
            posterPath: item.poster_path,
            backdropPath: item.backdrop_path,
            releaseDate:
                typeof rawDate === 'string' && rawDate.length > 0
                    ? rawDate
                    : null,
            originalLanguage: item.original_language,
            genreIds: item.genre_ids,
        },
    };
}

function shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// The 8 blend sources — each is one (content-source × media) pair, which is
// exactly what lets us satisfy BOTH the source mix AND the movie/TV split with
// a single per-task target.
const SOURCES: {
    source: SourceKey;
    media: MediaType;
    fetch: (
        page: number,
    ) => Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>>;
}[] = [
    { source: 'trending', media: 'movie', fetch: (p) => getTrending('movie', p) },
    { source: 'trending', media: 'tv', fetch: (p) => getTrending('tv', p) },
    { source: 'popular', media: 'movie', fetch: (p) => getPopular('movie', p) },
    { source: 'popular', media: 'tv', fetch: (p) => getPopular('tv', p) },
    { source: 'topRated', media: 'movie', fetch: (p) => getTopRated('movie', p) },
    { source: 'topRated', media: 'tv', fetch: (p) => getTopRated('tv', p) },
    {
        source: 'discover',
        media: 'movie',
        fetch: (p) => discoverByGenre('movie', DISCOVER_GENRES, p),
    },
    {
        source: 'discover',
        media: 'tv',
        fetch: (p) => discoverByGenre('tv', DISCOVER_GENRES, p),
    },
];

// Aggregate one source's pages into a flat result list, tolerating per-page
// failures (a dropped page just contributes fewer titles — graceful
// degradation). Never rejects, so Promise.all over sources is safe.
async function loadSource(s: (typeof SOURCES)[number]): Promise<{
    source: SourceKey;
    media: MediaType;
    items: (TMDBMovieSummary | TMDBTVSummary)[];
}> {
    const pages = await Promise.allSettled(
        Array.from({ length: PAGES_PER_SOURCE }, (_, i) => s.fetch(i + 1)),
    );
    const items = pages.flatMap((p) =>
        p.status === 'fulfilled' ? p.value.results : [],
    );
    return { source: s.source, media: s.media, items };
}

function targetFor(source: SourceKey, media: MediaType): number {
    const mediaShare = media === 'movie' ? MOVIE_SHARE : 1 - MOVIE_SHARE;
    return Math.round(TILE_COUNT * SOURCE_MIX[source] * mediaShare);
}

// Build the grid from each source's already-aggregated items (failed pages
// were dropped upstream in loadSource). Takes each source's per-task target
// (shuffled), de-dupes by (media, id) across sources, then shuffles, backfills
// from the overflow, and trims to TILE_COUNT. An empty source just contributes
// nothing — the grid renders from whatever survived.
function composeBlend(
    sources: {
        source: SourceKey;
        media: MediaType;
        items: (TMDBMovieSummary | TMDBTVSummary)[];
    }[],
): Tile[] {
    const seen = new Set<string>();
    const picked: Tile[] = [];
    const leftover: Tile[] = [];

    for (const { source, media, items } of sources) {
        const tiles = shuffle(
            items
                .map((r) => summaryToTile(r, media))
                .filter((t): t is Tile => t !== null),
        );
        const target = targetFor(source, media);
        let taken = 0;
        for (const t of tiles) {
            if (seen.has(t.key)) continue;
            seen.add(t.key);
            if (taken < target) {
                picked.push(t);
                taken++;
            } else {
                leftover.push(t);
            }
        }
    }

    let grid = shuffle(picked);
    if (grid.length < TILE_COUNT) grid = grid.concat(shuffle(leftover));
    return grid.slice(0, TILE_COUNT);
}

export default function PosterGridScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();

    const [grid, setGrid] = useState<Tile[] | null>(null);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [failed, setFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    // Selected (watched) tiles by key. Optimistic — the write follows.
    const [selected, setSelected] = useState<Set<string>>(() => new Set());

    useEffect(() => {
        let active = true;
        setLoading(true);
        setFailed(false);
        (async () => {
            const sources = await Promise.all(SOURCES.map(loadSource));
            if (!active) return;
            const tiles = composeBlend(sources);
            if (tiles.length >= MIN_TILES_TO_RENDER) setGrid(tiles);
            else setFailed(true);
            setLoading(false);
        })();
        return () => {
            active = false;
        };
    }, [reloadKey]);

    function toggle(tile: Tile) {
        const nowSelected = !selected.has(tile.key);
        // Optimistic flip first so the tile responds instantly.
        setSelected((prev) => {
            const next = new Set(prev);
            if (nowSelected) next.add(tile.key);
            else next.delete(tile.key);
            return next;
        });
        void (async () => {
            try {
                // Mark watched on select; remove the item on unselect. Same
                // shared write the other onboarding steps use.
                await setOnboardingItemStatus(
                    tile.title,
                    nowSelected ? 'watched' : null,
                );
            } catch (err) {
                // Revert the optimistic toggle on failure.
                setSelected((prev) => {
                    const next = new Set(prev);
                    if (nowSelected) next.delete(tile.key);
                    else next.add(tile.key);
                    return next;
                });
                console.error('poster-grid mark failed:', err);
                Alert.alert(
                    "Couldn't save",
                    err instanceof Error ? err.message : 'Unknown error',
                );
            }
        })();
    }

    // Continue + Skip both advance to the invite step (the grid is optional
    // seeding — no minimum selection). finishOnboarding still lives on invite.
    function goNext() {
        router.push('/(onboarding)/invite');
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <OnboardingProgress currentStep={4} totalSteps={4} />
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <ChevronLeft
                        color={palette.accent}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
            </View>

            <View style={styles.intro}>
                <Text style={[typography.display, { color: palette.text }]}>
                    Seen any of these?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Tap the movies and shows you&apos;ve seen to build up your
                    library.
                </Text>
            </View>

            <View style={styles.body}>
                {showLoader ? (
                    <FullScreenLoader />
                ) : failed || !grid ? (
                    <LoadError
                        title="Couldn't load suggestions"
                        onRetry={() => setReloadKey((k) => k + 1)}
                    />
                ) : (
                    <FlatList
                        data={grid}
                        numColumns={NUM_COLUMNS}
                        keyExtractor={(t) => t.key}
                        style={styles.flex}
                        columnWrapperStyle={styles.gridRow}
                        contentContainerStyle={styles.gridContent}
                        showsVerticalScrollIndicator={false}
                        renderItem={({ item }) => (
                            <PosterTileView
                                tile={item}
                                selected={selected.has(item.key)}
                                onToggle={() => toggle(item)}
                                palette={palette}
                            />
                        )}
                    />
                )}
            </View>

            <View
                style={[
                    styles.footer,
                    { paddingBottom: insets.bottom + spacing.sm },
                ]}
            >
                <Pressable
                    onPress={goNext}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Continue
                    </Text>
                </Pressable>
                <Pressable
                    onPress={goNext}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.skipButton,
                        { opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        Skip
                    </Text>
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

function PosterTileView({
    tile,
    selected,
    onToggle,
    palette,
}: {
    tile: Tile;
    selected: boolean;
    onToggle: () => void;
    palette: ReturnType<typeof getPalette>;
}) {
    return (
        <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={tile.title.title}
            style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.85 : 1 }]}
        >
            <Image
                source={{ uri: imageUrl(tile.poster, 'w185') }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={120}
            />
            {selected ? (
                <View
                    style={[
                        styles.selectedOverlay,
                        { borderColor: palette.accent },
                    ]}
                >
                    <View
                        style={[styles.check, { backgroundColor: palette.accent }]}
                    >
                        <Check
                            color={palette.textInverse}
                            size={16}
                            strokeWidth={3}
                        />
                    </View>
                </View>
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    flex: { flex: 1 },
    header: { paddingVertical: spacing.sm },
    intro: { gap: spacing.xs, paddingBottom: spacing.md },
    body: { flex: 1 },
    gridContent: { paddingTop: spacing.xs, paddingBottom: spacing.lg },
    gridRow: { gap: spacing.sm, marginBottom: spacing.sm },
    tile: {
        flex: 1,
        aspectRatio: 2 / 3, // poster ratio (taller than wide)
        borderRadius: radius.sm,
        overflow: 'hidden',
    },
    selectedOverlay: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: radius.sm,
        borderWidth: 3,
        backgroundColor: 'rgba(0,0,0,0.35)',
        alignItems: 'flex-end',
    },
    check: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        margin: spacing.xs,
    },
    footer: { gap: spacing.sm, paddingTop: spacing.sm },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
