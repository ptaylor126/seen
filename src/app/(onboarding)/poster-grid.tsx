import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
    CaretLeft,
    Check,
} from 'phosphor-react-native';
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
    posterFrame,
    button,
    getPalette,
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
// de-dupe + poster-filter + the client-side recognisability filters below (which
// drop a large share of popular/trending), so we fetch several per source and
// tolerate per-page failures. Tunable; cost is (active sources × 2 media) × this
// many proxy calls per load — currently 3 sources × 2 × 5 = 30.
const PAGES_PER_SOURCE = 5;
// 70% movies / 30% TV — TV skews more obscure across every source (anime,
// international, telenovelas, docs), so films carry recognisability.
const MOVIE_SHARE = 0.7;
// Per-content-source share of the grid (sums to ~1). Recognisability-first:
// trending + popular carry it; discover adds a filtered genre-spread garnish.
// top_rated is DISABLED (0) — TMDB's top_rated is a fixed acclaim-ranked list
// (old / foreign / arthouse / anime / docs) that can't be filtered. The SOURCES
// builder below only fetches sources whose share is > 0, so a 0 share is
// dropped from the fetch set AND the backfill pool — set a share back to >0 to
// re-enable, no other change needed.
const SOURCE_MIX = {
    trending: 0.4,
    popular: 0.45,
    topRated: 0,
    discover: 0.15,
} as const;
// Discover genres (TMDB ids); pipe-joined = OR-match (see discoverByGenre —
// TMDB treats comma as AND). Action, Adventure, Comedy, Sci-Fi, Animation.
// Drama (18) dropped — it was the biggest
// international / K-drama puller. Animation (16) stays: the English-language
// filter below turns it into Western animation (Pixar/DreamWorks), not anime.
const DISCOVER_GENRES = [28, 12, 35, 878, 16];
// Discover-query language bias (server-side, discover slice ONLY — TMDB's fixed
// trending/popular lists ignore this param). Keeps the genre-spread garnish
// English-leaning; famous non-English titles (Squid Game, Parasite) still arrive
// via trending/popular and survive the vote floor below.
const DISCOVER_LANGUAGE = 'en';

// --- Client-side recognisability filters, applied to EVERY source's results in
//     composeBlend so they also reach popular/trending, whose fixed TMDB lists
//     can't be query-filtered. Dial these on the dev build. ---
// PRIMARY lever: drop titles below this many votes. The obscure long-tail
// (regional, low-vote, ecchi anime) sits at ~10–70 votes; mainstream sits in
// the hundreds–thousands — so this is language-agnostic (Squid Game / Parasite
// survive). Also passed to the discover query as vote_count.gte.
const MIN_VOTE_COUNT = 400;
// OPTIONAL hard language gate across all sources. EMPTY = disabled (rely on the
// vote floor, which keeps recognisable non-English). Populate e.g. ['en'] to
// hard-restrict.
const LANGUAGE_ALLOWLIST: readonly string[] = [];
// TV-only: drop animation that isn't English-language — kills anime while
// keeping Western animation (Bluey, Rick and Morty). Toggle off to allow anime.
const EXCLUDE_NON_ENGLISH_TV_ANIME = true;
const ANIMATION_GENRE_ID = 16; // TMDB genre id for Animation
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

// Per-source fetchers keyed by SourceKey. The discover fetcher carries the
// recognisability filters (explicit popularity sort + English language + vote
// floor); the other three are TMDB's fixed lists and take no filters.
const SOURCE_FETCHERS: Record<
    SourceKey,
    (
        media: MediaType,
        page: number,
    ) => Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>>
> = {
    trending: (media, page) => getTrending(media, page),
    popular: (media, page) => getPopular(media, page),
    topRated: (media, page) => getTopRated(media, page),
    discover: (media, page) =>
        discoverByGenre(media, DISCOVER_GENRES, page, {
            sort_by: 'popularity.desc',
            with_original_language: DISCOVER_LANGUAGE,
            'vote_count.gte': MIN_VOTE_COUNT,
        }),
};

// The active blend sources — one (source × media) pair per source whose
// SOURCE_MIX share is > 0, which is exactly what lets us satisfy BOTH the source
// mix AND the movie/TV split with a single per-task target. A source at share 0
// (e.g. topRated) is skipped entirely: never fetched, so it can't leak into the
// backfill pool either.
const SOURCES: {
    source: SourceKey;
    media: MediaType;
    fetch: (
        page: number,
    ) => Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>>;
}[] = (Object.keys(SOURCE_MIX) as SourceKey[])
    .filter((source) => SOURCE_MIX[source] > 0)
    .flatMap((source) =>
        (['movie', 'tv'] as MediaType[]).map((media) => ({
            source,
            media,
            fetch: (page: number) => SOURCE_FETCHERS[source](media, page),
        })),
    );

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

// Client-side recognisability filter applied to EVERY source's raw results
// before they become tiles — this is what cleans popular/trending, whose fixed
// TMDB lists can't be query-filtered. Order: vote floor (primary lever), adult
// safety gate, optional hard language allowlist, then the TV-anime exclusion.
function passesRecognisabilityFilter(
    item: TMDBMovieSummary | TMDBTVSummary,
    media: MediaType,
): boolean {
    // Primary: vote-count floor — drops the obscure/low-vote long-tail across
    // all sources, language-agnostically. (`?? 0` guards a malformed response.)
    if ((item.vote_count ?? 0) < MIN_VOTE_COUNT) return false;
    // Never surface adult-flagged content in onboarding.
    if (item.adult === true) return false;
    // Optional hard language gate (empty allowlist = disabled).
    if (
        LANGUAGE_ALLOWLIST.length > 0 &&
        !LANGUAGE_ALLOWLIST.includes(item.original_language)
    ) {
        return false;
    }
    // TV-only: non-English animation = anime → drop; Western animation stays.
    if (
        EXCLUDE_NON_ENGLISH_TV_ANIME &&
        media === 'tv' &&
        item.original_language !== 'en' &&
        item.genre_ids.includes(ANIMATION_GENRE_ID)
    ) {
        return false;
    }
    return true;
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
                .filter((r) => passesRecognisabilityFilter(r, media))
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
                    <CaretLeft
                        color={palette.accent}
                        size={28}
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
                {/* Aside for users arriving with history elsewhere — the
                    tap-a-grid path is slow for them, and the importer
                    (Profile → Import your library, LIBRARY_IMPORT_ENABLED)
                    does the same job in one pass. Deliberately NOT a step
                    or a link: it plants the idea without adding a branch
                    to the flow.
                    micro/textFaint, one tier BELOW the body instruction —
                    a footnote, not a third thing to read. */}
                <Text
                    style={[
                        typography.micro,
                        styles.introAside,
                        { color: palette.textFaint },
                    ]}
                >
                    Track films elsewhere? Import from your profile.
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
    // Extra breath above the import aside: the intro's own gap is xs (4),
    // too tight for the caption to read as a separate tier rather than a
    // wrapped continuation of the body. +xs = 8pt total separation.
    // Row now, to seat the leading glyph beside the text.
    introAside: {
        // Separated from the body instruction above (the intro's own gap
        // is xs/4) so it reads as a note rather than a third instruction
        // line. Plain Text now — no icon, no row.
        marginTop: spacing.sm,
    },
    body: { flex: 1 },
    gridContent: { paddingTop: spacing.xs, paddingBottom: spacing.lg },
    gridRow: { gap: spacing.sm, marginBottom: spacing.sm },
    tile: {
        ...posterFrame,
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
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        margin: spacing.xs,
    },
    footer: { gap: spacing.sm, paddingTop: spacing.sm },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
