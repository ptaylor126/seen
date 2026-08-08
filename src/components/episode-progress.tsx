import {
    Minus,
    Plus,
} from 'phosphor-react-native';
import {
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import supabase from '@/lib/supabase';
import type { TMDBSeason } from '@/lib/tmdb';
import {
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Collapse rapid stepper taps into a single write.
const WRITE_DEBOUNCE_MS = 700;

interface EpisodeProgressProps {
    tmdbId: number;
    // Persisted progress, or null when not tracked yet (→ display S1·E1, which
    // the first stepper tap persists — no explicit "track" button).
    initialSeason: number | null;
    initialEpisode: number | null;
    // TMDB clamp data (already on the detail response).
    seasons: TMDBSeason[] | undefined;
    numberOfSeasons: number;
}

interface Bounds {
    minSeason: number;
    maxSeason: number;
    episodeCountBySeason: Map<number, number>;
    // True only when TMDB gives seasons but none is a real (>= 1) season with
    // episodes — i.e. a specials-only show. The control isn't rendered then.
    specialsOnly: boolean;
}

// Build the clamp model from TMDB seasons. A season counts as real only if its
// number is >= 1 (Season 0 = TMDB "Specials" is excluded from stepping) AND it
// has a positive episode_count (drops unaired/phantom seasons). The surviving
// season_numbers give the season range — so the floor is the first real season,
// never Season 0 — and their counts cap the episode stepper. Missing/zero
// counts leave a season uncapped rather than blocking input.
function buildBounds(
    seasons: TMDBSeason[] | undefined,
    numberOfSeasons: number,
): Bounds {
    const real = (seasons ?? []).filter(
        (s) =>
            typeof s.season_number === 'number' &&
            s.season_number >= 1 &&
            typeof s.episode_count === 'number' &&
            s.episode_count > 0,
    );
    const episodeCountBySeason = new Map<number, number>();
    for (const s of real) episodeCountBySeason.set(s.season_number, s.episode_count);

    const numbers = real.map((s) => s.season_number).sort((a, b) => a - b);
    const minSeason = numbers.length > 0 ? numbers[0] : 1;
    const maxSeason =
        numbers.length > 0
            ? numbers[numbers.length - 1]
            : Math.max(1, numberOfSeasons || 1);

    // Specials-only is knowable only when seasons[] is present but yields no
    // real season. Missing/empty seasons[] stays renderable (lenient — we fall
    // back to numberOfSeasons and uncapped episodes).
    const specialsOnly = (seasons?.length ?? 0) > 0 && real.length === 0;

    return { minSeason, maxSeason, episodeCountBySeason, specialsOnly };
}

// Compact one-row progress control for a Watching TV show: Season −/+ and
// Episode −/+ steppers. Writes are debounced and serialized (last value wins,
// no stale clobber) and flushed on unmount so leaving the screen never drops
// the latest tap.
export function EpisodeProgress({
    tmdbId,
    initialSeason,
    initialEpisode,
    seasons,
    numberOfSeasons,
}: EpisodeProgressProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const bounds = useMemo(
        () => buildBounds(seasons, numberOfSeasons),
        [seasons, numberOfSeasons],
    );

    // Clamp the persisted value into the real-season range on mount, so a
    // legacy/odd Season 0 never displays (the floor is the first real season).
    const [season, setSeason] = useState(() =>
        Math.min(
            Math.max(initialSeason ?? bounds.minSeason, bounds.minSeason),
            bounds.maxSeason,
        ),
    );
    const [episode, setEpisode] = useState(() => Math.max(1, initialEpisode ?? 1));

    // Debounce timer + the latest value to persist. dirtyRef marks unsaved
    // changes; inFlightRef serializes writes so a late write can't overwrite a
    // newer one (the version guard — the loop below always re-writes the latest
    // value if it changed mid-flight).
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestRef = useRef({
        season: initialSeason ?? 1,
        episode: initialEpisode ?? 1,
    });
    const dirtyRef = useRef(false);
    const inFlightRef = useRef(false);

    const flush = useCallback(async () => {
        if (inFlightRef.current || !dirtyRef.current) return;
        inFlightRef.current = true;
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) return;

            // Re-write until no newer change arrived during the await — last
            // value always wins.
            while (dirtyRef.current) {
                dirtyRef.current = false;
                const { season: s, episode: e } = latestRef.current;
                // reason: progress_season / progress_episode come from the
                // pending migration (20260707120000) and aren't in the
                // generated Supabase types yet; cast the payload until the
                // types are regenerated after the migration is applied.
                const payload = {
                    progress_season: s,
                    progress_episode: e,
                    updated_at: new Date().toISOString(),
                } as never;
                const { error } = await supabase
                    .from('items')
                    .update(payload)
                    .eq('user_id', userId)
                    .eq('tmdb_id', tmdbId)
                    .eq('media_type', 'tv');
                if (error) {
                    console.warn('episode progress write failed:', error.message);
                    return;
                }
            }
        } catch (err) {
            console.warn('episode progress write failed:', err);
        } finally {
            inFlightRef.current = false;
        }
    }, [tmdbId]);

    function scheduleWrite(nextSeason: number, nextEpisode: number) {
        latestRef.current = { season: nextSeason, episode: nextEpisode };
        dirtyRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            void flush();
        }, WRITE_DEBOUNCE_MS);
    }

    // Flush any pending write when the control unmounts (navigating away,
    // status change hiding it).
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            void flush();
        };
    }, [flush]);

    // Specials-only show (TMDB gives only Season 0) — nothing to step, so don't
    // render the control at all. (After hooks, so hook order stays stable.)
    if (bounds.specialsOnly) return null;

    function clampEpisode(forSeason: number, ep: number): number {
        const cap = bounds.episodeCountBySeason.get(forSeason);
        const upper = cap && cap > 0 ? cap : Infinity; // missing count → uncapped
        return Math.min(Math.max(1, ep), upper);
    }

    function changeSeason(delta: number) {
        const next = Math.min(
            Math.max(bounds.minSeason, season + delta),
            bounds.maxSeason,
        );
        if (next === season) return;
        setSeason(next);
        setEpisode(1); // Season ± resets the episode to 1.
        scheduleWrite(next, 1);
    }

    function changeEpisode(delta: number) {
        const next = clampEpisode(season, episode + delta);
        if (next === episode) return;
        setEpisode(next);
        scheduleWrite(season, next);
    }

    const atMinSeason = season <= bounds.minSeason;
    const atMaxSeason = season >= bounds.maxSeason;
    const epCap = bounds.episodeCountBySeason.get(season);
    const atMinEpisode = episode <= 1;
    const atMaxEpisode = !!epCap && epCap > 0 && episode >= epCap;

    return (
        <View style={styles.row}>
            <Stepper
                label="Season"
                value={season}
                palette={palette}
                minusDisabled={atMinSeason}
                plusDisabled={atMaxSeason}
                onMinus={() => changeSeason(-1)}
                onPlus={() => changeSeason(1)}
            />
            <Stepper
                label="Episode"
                value={episode}
                palette={palette}
                minusDisabled={atMinEpisode}
                plusDisabled={atMaxEpisode}
                onMinus={() => changeEpisode(-1)}
                onPlus={() => changeEpisode(1)}
            />
        </View>
    );
}

function Stepper({
    label,
    value,
    palette,
    minusDisabled,
    plusDisabled,
    onMinus,
    onPlus,
}: {
    label: string;
    value: number;
    palette: ReturnType<typeof getPalette>;
    minusDisabled: boolean;
    plusDisabled: boolean;
    onMinus: () => void;
    onPlus: () => void;
}) {
    return (
        <View style={styles.stepperGroup}>
            <Text style={[typography.caption, { color: palette.textMuted }]}>
                {label}
            </Text>
            <View style={styles.stepper}>
                <StepButton
                    palette={palette}
                    disabled={minusDisabled}
                    onPress={onMinus}
                    accessibilityLabel={`Decrease ${label.toLowerCase()}`}
                >
                    <Minus
                        color={
                            minusDisabled ? palette.textMuted : palette.accent
                        }
                        size={16}
                    />
                </StepButton>
                <Text
                    style={[
                        typography.bodyEmphasis,
                        styles.value,
                        { color: palette.text },
                    ]}
                >
                    {value}
                </Text>
                <StepButton
                    palette={palette}
                    disabled={plusDisabled}
                    onPress={onPlus}
                    accessibilityLabel={`Increase ${label.toLowerCase()}`}
                >
                    <Plus
                        color={
                            plusDisabled ? palette.textMuted : palette.accent
                        }
                        size={16}
                    />
                </StepButton>
            </View>
        </View>
    );
}

function StepButton({
    palette,
    disabled,
    onPress,
    accessibilityLabel,
    children,
}: {
    palette: ReturnType<typeof getPalette>;
    disabled: boolean;
    onPress: () => void;
    accessibilityLabel: string;
    children: ReactNode;
}) {
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            hitSlop={spacing.xs}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled }}
            style={({ pressed }) => [
                styles.stepButton,
                {
                    backgroundColor: palette.accentWash,
                    opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
                },
            ]}
        >
            {children}
        </Pressable>
    );
}

const STEP_SIZE = 28;

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.lg,
        paddingHorizontal: spacing.base,
        marginTop: spacing.md,
    },
    stepperGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    stepper: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    stepButton: {
        width: STEP_SIZE,
        height: STEP_SIZE,
        borderRadius: STEP_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    value: {
        minWidth: 20,
        textAlign: 'center',
    },
});
