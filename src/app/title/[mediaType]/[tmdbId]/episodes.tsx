import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    CaretLeft,
    ChatCircle,
} from 'phosphor-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { LoadError } from '@/components/load-error';
import { Text } from '@/components/text';
import supabase from '@/lib/supabase';
import {
    getTV,
    getTVSeason,
    imageUrl,
    type TMDBEpisode,
    type TMDBSeason,
} from '@/lib/tmdb';
import {
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Episode-list screen (TV only) — a dedicated route off the title page, not
// inline. A season picker + the selected season's episodes (number, name,
// still, overview). Each episode opens an episode-scoped chat via the SAME
// compose screen the whole-show "Chat with a friend" door uses, forwarding
// season + episode. Defaults to the season the user's progress is in
// (items.progress_season), falling back to season 1.
export default function EpisodeListScreen() {
    const params = useLocalSearchParams<{ mediaType: string; tmdbId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    const tmdbId = Number.parseInt(
        typeof params.tmdbId === 'string' ? params.tmdbId : '',
        10,
    );
    // This screen is TV-only; a movie route here is a programming error, but
    // guard so we render a clean error rather than a bad TMDB call.
    const isTv = params.mediaType === 'tv';

    const [seasons, setSeasons] = useState<TMDBSeason[]>([]);
    const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
    const [episodes, setEpisodes] = useState<TMDBEpisode[]>([]);
    const [loading, setLoading] = useState(true);
    const [episodesLoading, setEpisodesLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const showLoader = useDeferredLoading(loading);

    // One-time load: the season list (from the TV detail) + the user's
    // progress season, which seeds the default selection.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!isTv || !Number.isFinite(tmdbId)) {
                setError('This screen is only available for TV shows.');
                setLoading(false);
                return;
            }
            try {
                const [detail, progressSeason] = await Promise.all([
                    getTV(tmdbId),
                    (async () => {
                        const {
                            data: { session },
                        } = await supabase.auth.getSession();
                        const userId = session?.user.id;
                        if (!userId) return null;
                        const { data } = await supabase
                            .from('items')
                            .select('progress_season')
                            .eq('user_id', userId)
                            .eq('tmdb_id', tmdbId)
                            .eq('media_type', 'tv')
                            .maybeSingle();
                        return data?.progress_season ?? null;
                    })(),
                ]);
                if (cancelled) return;

                // Seasons with real episodes. Numbered seasons ascending, with
                // Specials (season 0) forced to the END — it's the least
                // important season, so it must not sort first or open by
                // default.
                const sortKey = (n: number) => (n === 0 ? Infinity : n);
                const usable = (detail.seasons ?? [])
                    .filter((s) => s.episode_count > 0)
                    .sort(
                        (a, b) =>
                            sortKey(a.season_number) - sortKey(b.season_number),
                    );
                const fallback: TMDBSeason[] =
                    usable.length > 0
                        ? usable
                        : Array.from(
                              { length: detail.number_of_seasons || 1 },
                              (_, i) => ({
                                  season_number: i + 1,
                                  episode_count: 0,
                                  name: `Season ${i + 1}`,
                              }),
                          );
                setSeasons(fallback);

                // Default to the progress season ONLY when it's a real
                // numbered season we can show; otherwise the first numbered
                // season (Season 1). Specials (0) is never the auto-open, and
                // progress_season === 0 falls through to Season 1.
                const has = (n: number) =>
                    fallback.some((s) => s.season_number === n);
                const firstNumbered =
                    fallback.find((s) => s.season_number >= 1)?.season_number ??
                    fallback[0]?.season_number ??
                    1;
                setSelectedSeason(
                    progressSeason !== null &&
                        progressSeason >= 1 &&
                        has(progressSeason)
                        ? progressSeason
                        : firstNumbered,
                );
            } catch (err) {
                if (!cancelled) {
                    console.error('episodes: season load failed', err);
                    setError('Could not load episodes. Please try again.');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isTv, tmdbId]);

    // Episodes for the selected season — refetched whenever it changes.
    useEffect(() => {
        if (selectedSeason === null || !Number.isFinite(tmdbId)) return;
        let cancelled = false;
        setEpisodesLoading(true);
        getTVSeason(tmdbId, selectedSeason)
            .then((detail) => {
                if (!cancelled) setEpisodes(detail.episodes ?? []);
            })
            .catch((err) => {
                if (!cancelled) {
                    console.error('episodes: season fetch failed', err);
                    setEpisodes([]);
                }
            })
            .finally(() => {
                if (!cancelled) setEpisodesLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedSeason, tmdbId]);

    const openEpisodeChat = useCallback(
        (episodeNumber: number) => {
            if (selectedSeason === null) return;
            router.push({
                pathname: '/title/[mediaType]/[tmdbId]/chat',
                params: {
                    mediaType: 'tv',
                    tmdbId: String(tmdbId),
                    season: String(selectedSeason),
                    episode: String(episodeNumber),
                },
            });
        },
        [router, tmdbId, selectedSeason],
    );

    const seasonLabel = useCallback(
        (n: number) => (n === 0 ? 'Specials' : `Season ${n}`),
        [],
    );

    const header = (
        <View style={styles.header}>
            <Pressable
                onPress={() => router.back()}
                hitSlop={spacing.sm}
                accessibilityRole="button"
                accessibilityLabel="Back"
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
                <CaretLeft
                    color={palette.accent}
                    size={28}
                />
            </Pressable>
            <Text style={[typography.heading, { color: palette.text }]}>
                Episodes
            </Text>
        </View>
    );

    const seasonPicker = useMemo(
        () => (
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.seasonScroll}
                contentContainerStyle={styles.seasonRow}
            >
                {seasons.map((s) => (
                    <Chip
                        key={s.season_number}
                        label={seasonLabel(s.season_number)}
                        active={s.season_number === selectedSeason}
                        onPress={() => setSelectedSeason(s.season_number)}
                        accessibilityLabel={`Show ${seasonLabel(
                            s.season_number,
                        )}`}
                    />
                ))}
            </ScrollView>
        ),
        [seasons, selectedSeason, seasonLabel],
    );

    if (showLoader) {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top', 'bottom']}
            >
                {header}
                <FullScreenLoader />
            </SafeAreaView>
        );
    }

    if (error) {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top', 'bottom']}
            >
                {header}
                <LoadError message={error} />
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top', 'bottom']}
        >
            {header}
            {seasonPicker}
            <ScrollView style={styles.listScroll} contentContainerStyle={styles.list}>
                {episodesLoading ? (
                    <ActivityIndicator
                        color={palette.accent}
                        style={styles.episodesSpinner}
                    />
                ) : episodes.length === 0 ? (
                    <Text
                        style={[
                            typography.body,
                            styles.emptyText,
                            { color: palette.textMuted },
                        ]}
                    >
                        No episodes to show for this season yet.
                    </Text>
                ) : (
                    episodes.map((ep) => (
                        <View key={ep.episode_number}>
                            {ep.still_path ? (
                                <Image
                                    source={{
                                        // w780: stills render near full width
                                        // (~1074 physical px on a 3x phone) —
                                        // w342 was a 2-3x upscale, the softest
                                        // image in the app. NOT w1280/original:
                                        // this is a scrolling list of many
                                        // stills, so w780 is the sharpness/
                                        // weight balance.
                                        uri: imageUrl(ep.still_path, 'w780'),
                                    }}
                                    style={styles.still}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.still,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <View style={styles.cardBody}>
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={2}
                                >
                                    E{ep.episode_number} · {ep.name}
                                </Text>
                                {ep.overview ? (
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.textMuted },
                                        ]}
                                        numberOfLines={3}
                                    >
                                        {ep.overview}
                                    </Text>
                                ) : null}
                                <Pressable
                                    onPress={() =>
                                        openEpisodeChat(ep.episode_number)
                                    }
                                    accessibilityRole="button"
                                    accessibilityLabel={`Chat about episode ${ep.episode_number}`}
                                    style={({ pressed }) => [
                                        styles.chatDoor,
                                        { opacity: pressed ? 0.6 : 1 },
                                    ]}
                                >
                                    <ChatCircle
                                        color={palette.accent}
                                        size={18}
                                    />
                                    <Text
                                        style={[
                                            typography.bodyEmphasis,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        Chat with a friend
                                    </Text>
                                </Pressable>
                            </View>
                        </View>
                    ))
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        // More breathing room below the safe-area top edge (was sm) so the
        // back chevron + title aren't cramped against the top.
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },
    // flexGrow:0 so the horizontal strip hugs its content height and reserves
    // its row in the column — without it the episode list below isn't confined
    // beneath the strip and overlaps the chips.
    seasonScroll: {
        flexGrow: 0,
    },
    seasonRow: {
        flexDirection: 'row',
        gap: spacing.xs,
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
    // flex:1 so the vertical list fills only the space beneath the strip and
    // scrolls internally (a ScrollView in a flex column must be bounded).
    listScroll: {
        flex: 1,
    },
    list: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.xl,
        // Inter-episode gap = the space below one episode's chat door and the
        // next episode's still (lg, up from md).
        gap: spacing.lg,
    },
    episodesSpinner: { marginTop: spacing.xl },
    emptyText: { marginTop: spacing.xl, textAlign: 'center' },
    // No card — the still, title and overview sit on the page background. The
    // still is a rounded image; the text below aligns to its left edge (the
    // list's own 16 inset), so cardBody carries no horizontal padding.
    still: {
        width: '100%',
        aspectRatio: 16 / 9,
        borderRadius: radius.md,
    },
    cardBody: {
        paddingTop: spacing.sm,
        gap: spacing.sm,
    },
    chatDoor: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingTop: spacing.xs,
    },
});
