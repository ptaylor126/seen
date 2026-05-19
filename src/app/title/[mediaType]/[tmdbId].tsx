import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ThumbsDown, ThumbsUp, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

type MediaType = 'movie' | 'tv';
type ItemStatus = 'watchlist' | 'watching' | 'watched';
type RatingThumb = 'up' | 'down';

// Thumbs-up / thumbs-down map onto the legacy 5-star items.rating column
// (the only rating storage we have). Up = 4 (positive), down = 2 (negative),
// null = skipped (no rating recorded). Matching open recs also get their
// rating_thumb field set in the same flow when applicable.
const RATING_FROM_THUMB: Record<RatingThumb, number> = { up: 4, down: 2 };

// Discriminated union so render code can narrow on `type` and access the
// right shape (TMDBMovie.title vs TMDBTV.name etc.).
type Detail =
    | { type: 'movie'; data: TMDBMovie }
    | { type: 'tv'; data: TMDBTV };

const STATUSES: ItemStatus[] = ['watchlist', 'watching', 'watched'];
const STATUS_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};

const BACKDROP_HEIGHT = 240;
const POSTER_WIDTH = 100;
const POSTER_HEIGHT = 150;

export default function TitleDetailScreen() {
    const params = useLocalSearchParams<{ mediaType: string; tmdbId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);

    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentStatus, setCurrentStatus] = useState<ItemStatus | null>(null);
    const [updating, setUpdating] = useState(false);
    const [showRatingSheet, setShowRatingSheet] = useState(false);
    const [ratingBusy, setRatingBusy] = useState(false);

    // Load title detail (TMDB) and the current library status (Supabase) in
    // parallel. The detail fetch picks getMovie or getTV based on mediaType
    // and wraps the result in the discriminated Detail union so JSX can
    // narrow cleanly downstream.
    useEffect(() => {
        if (!mediaType || !Number.isFinite(tmdbId)) {
            setError('Invalid title');
            setLoading(false);
            return;
        }

        let active = true;

        const detailPromise: Promise<Detail> =
            mediaType === 'movie'
                ? getMovie(tmdbId).then((data) => ({ type: 'movie' as const, data }))
                : getTV(tmdbId).then((data) => ({ type: 'tv' as const, data }));

        (async () => {
            try {
                const [resolvedDetail, sessionResult] = await Promise.all([
                    detailPromise,
                    supabase.auth.getSession(),
                ]);
                if (!active) return;
                setDetail(resolvedDetail);

                const userId = sessionResult.data.session?.user.id;
                if (userId) {
                    const { data: item } = await supabase
                        .from('items')
                        .select('status')
                        .eq('user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle();
                    if (!active) return;
                    if (item && STATUSES.includes(item.status as ItemStatus)) {
                        setCurrentStatus(item.status as ItemStatus);
                    }
                }
            } catch (err) {
                if (active) setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId]);

    async function setStatus(newStatus: ItemStatus) {
        // Block re-entry: while a status update is in flight, or while the
        // rating sheet is already open / its network call is mid-air,
        // ignore further taps.
        if (updating || ratingBusy || showRatingSheet || !mediaType) return;

        // Re-tapping Watched while already watched is meaningful — it
        // reopens the rating sheet so the user can change their thumb.
        // Skip the redundant upsert in that case.
        const watchedReTap = newStatus === 'watched' && currentStatus === 'watched';
        if (currentStatus === newStatus && !watchedReTap) return;

        let succeeded = !watchedReTap ? false : true;

        if (!watchedReTap) {
            setUpdating(true);
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const userId = session?.user.id;
                if (!userId) throw new Error('Not authenticated');

                const row = {
                    user_id: userId,
                    tmdb_id: tmdbId,
                    media_type: mediaType,
                    status: newStatus,
                    // Only stamp watched_at on the watched transition; other
                    // status changes leave it untouched (column-omit semantics
                    // in upsert means the existing value is preserved).
                    ...(newStatus === 'watched'
                        ? { watched_at: new Date().toISOString() }
                        : {}),
                };

                const { error: upsertError } = await supabase
                    .from('items')
                    .upsert(row, { onConflict: 'user_id,tmdb_id,media_type' });
                if (upsertError) throw upsertError;

                setCurrentStatus(newStatus);
                succeeded = true;
            } catch (err) {
                console.error('items upsert failed:', err);
                surfaceUpdateError(err);
            } finally {
                setUpdating(false);
            }
        }

        if (succeeded && newStatus === 'watched') {
            setShowRatingSheet(true);
        }
    }

    // Apply a thumbs-up/down rating (or skip with `null`) after a watched
    // transition. Updates items.rating when a thumb was chosen, and always
    // transitions any matching open recommendations (pending | accepted)
    // into `watched` — which fires the rec_watched notification trigger
    // for the sender. rating_thumb on the rec only gets set when the user
    // chose up/down; skipping leaves it null.
    async function handleRate(thumb: RatingThumb | null) {
        if (ratingBusy || !mediaType) return;
        setRatingBusy(true);
        // Close the sheet immediately so the UI doesn't trap the user
        // behind a spinner if the network is slow. Errors surface via
        // Alert; success is silent.
        setShowRatingSheet(false);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            if (thumb !== null) {
                const { error: itemError } = await supabase
                    .from('items')
                    .update({ rating: RATING_FROM_THUMB[thumb] })
                    .eq('user_id', userId)
                    .eq('tmdb_id', tmdbId)
                    .eq('media_type', mediaType);
                if (itemError) throw itemError;
            }

            const { data: openRecs, error: queryError } = await supabase
                .from('recommendations')
                .select('id')
                .eq('to_user_id', userId)
                .eq('tmdb_id', tmdbId)
                .eq('media_type', mediaType)
                .in('status', ['pending', 'accepted']);
            if (queryError) throw queryError;

            if (openRecs && openRecs.length > 0) {
                const update: {
                    status: 'watched';
                    watched_via_rec: boolean;
                    rating_thumb?: RatingThumb;
                } = {
                    status: 'watched',
                    watched_via_rec: true,
                };
                if (thumb !== null) update.rating_thumb = thumb;

                const { error: recError } = await supabase
                    .from('recommendations')
                    .update(update)
                    .in(
                        'id',
                        openRecs.map((r) => r.id),
                    );
                if (recError) throw recError;
            }
        } catch (err) {
            console.error('rating update failed:', err);
            surfaceUpdateError(err);
        } finally {
            setRatingBusy(false);
        }
    }

    // Shared error surfacing: PostgrestError fields land in Metro logs;
    // user sees message + hint in an Alert. Plain-Error path also covered.
    function surfaceUpdateError(err: unknown) {
        if (err && typeof err === 'object' && 'message' in err) {
            const supaErr = err as {
                message: string;
                details?: string;
                hint?: string;
                code?: string;
            };
            Alert.alert(
                'Update failed',
                `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
            );
        } else {
            Alert.alert('Update failed', String(err));
        }
    }

    const closeButtonTop = insets.top + spacing.sm;

    if (loading) {
        return (
            <View
                style={[styles.root, styles.fillCenter, { backgroundColor: palette.bg }]}
            >
                <ActivityIndicator color={palette.accent} />
                <CloseButton
                    top={closeButtonTop}
                    bg={palette.overlay}
                    fg={palette.textInverse}
                    onPress={router.back}
                />
            </View>
        );
    }

    if (error || !detail) {
        return (
            <View
                style={[styles.root, styles.fillCenter, { backgroundColor: palette.bg }]}
            >
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    {error ?? 'Title not available'}
                </Text>
                <CloseButton
                    top={closeButtonTop}
                    bg={palette.overlay}
                    fg={palette.textInverse}
                    onPress={router.back}
                />
            </View>
        );
    }

    const title = detail.type === 'movie' ? detail.data.title : detail.data.name;
    const dateField =
        detail.type === 'movie' ? detail.data.release_date : detail.data.first_air_date;
    const year = dateField ? dateField.slice(0, 4) : '';
    const extraMeta =
        detail.type === 'movie'
            ? detail.data.runtime
                ? `${detail.data.runtime} min`
                : ''
            : `${detail.data.number_of_seasons} season${
                  detail.data.number_of_seasons === 1 ? '' : 's'
              }`;
    const metaLine = [year, extraMeta].filter(Boolean).join(' · ');

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
                {/* Backdrop with a gradient fade at the bottom so the
                    seam between image and the surrounding content blends. */}
                <View style={styles.backdropContainer}>
                    {detail.data.backdrop_path ? (
                        <Image
                            source={{
                                uri: imageUrl(detail.data.backdrop_path, 'w780'),
                            }}
                            style={styles.backdrop}
                            contentFit="cover"
                            transition={200}
                        />
                    ) : (
                        <View
                            style={[
                                styles.backdrop,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                        />
                    )}
                    <LinearGradient
                        colors={['transparent', palette.bg]}
                        style={styles.backdropGradient}
                    />
                </View>

                {/* Poster overlaps the backdrop bottom; the title block
                    sits next to it. negative marginTop pulls the row up
                    onto the backdrop. */}
                <View style={styles.titleBlock}>
                    {detail.data.poster_path ? (
                        <Image
                            source={{
                                uri: imageUrl(detail.data.poster_path, 'w342'),
                            }}
                            style={styles.poster}
                            contentFit="cover"
                            transition={200}
                        />
                    ) : (
                        <View
                            style={[
                                styles.poster,
                                { backgroundColor: palette.surfaceAlt },
                            ]}
                        />
                    )}
                    <View style={styles.titleText}>
                        <Text
                            style={[typography.display, { color: palette.text }]}
                            numberOfLines={3}
                        >
                            {title}
                        </Text>
                        {metaLine ? (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {metaLine}
                            </Text>
                        ) : null}
                    </View>
                </View>

                {detail.data.tagline ? (
                    <Text
                        style={[
                            styles.tagline,
                            typography.body,
                            { color: palette.textMuted, fontStyle: 'italic' },
                        ]}
                    >
                        {detail.data.tagline}
                    </Text>
                ) : null}

                {detail.data.genres.length > 0 && (
                    <View style={styles.genres}>
                        {detail.data.genres.map((g) => (
                            <View
                                key={g.id}
                                style={[
                                    styles.genrePill,
                                    { backgroundColor: palette.surfaceAlt },
                                ]}
                            >
                                <Text
                                    style={[typography.micro, { color: palette.text }]}
                                >
                                    {g.name}
                                </Text>
                            </View>
                        ))}
                    </View>
                )}

                {detail.data.overview ? (
                    <Text
                        style={[styles.overview, typography.body, { color: palette.text }]}
                    >
                        {detail.data.overview}
                    </Text>
                ) : null}

                <View style={styles.actions}>
                    {STATUSES.map((status) => {
                        const isActive = currentStatus === status;
                        return (
                            <Pressable
                                key={status}
                                onPress={() => setStatus(status)}
                                disabled={updating}
                                style={({ pressed }) => [
                                    styles.actionButton,
                                    {
                                        backgroundColor: isActive
                                            ? palette.accent
                                            : 'transparent',
                                        borderColor: palette.accent,
                                        opacity: pressed || updating ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        {
                                            color: isActive
                                                ? palette.textInverse
                                                : palette.accent,
                                        },
                                    ]}
                                >
                                    {STATUS_LABELS[status]}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>

            <CloseButton
                top={closeButtonTop}
                bg={palette.overlay}
                fg={palette.textInverse}
                onPress={router.back}
            />

            {/* Rating sheet — opens after a successful Watched transition
                (or a re-tap of Watched). Tap outside or hit Skip to leave
                rating null. Nested-Pressable trick: outer Pressable
                handles tap-to-dismiss on the backdrop; inner Pressable
                with a no-op onPress consumes taps inside the sheet so
                they don't propagate up. */}
            <Modal
                visible={showRatingSheet}
                transparent
                animationType="slide"
                onRequestClose={() => handleRate(null)}
            >
                <Pressable
                    style={[styles.sheetBackdrop, { backgroundColor: palette.overlay }]}
                    onPress={() => handleRate(null)}
                >
                    <Pressable
                        style={[
                            styles.sheet,
                            {
                                backgroundColor: palette.surface,
                                paddingBottom: insets.bottom + spacing.lg,
                            },
                        ]}
                        onPress={() => {}}
                    >
                        <Text
                            style={[
                                typography.heading,
                                styles.sheetTitle,
                                { color: palette.text },
                            ]}
                        >
                            How was it?
                        </Text>
                        <View style={styles.sheetActions}>
                            <Pressable
                                onPress={() => handleRate('up')}
                                disabled={ratingBusy}
                                style={({ pressed }) => [
                                    styles.thumbButton,
                                    {
                                        backgroundColor: palette.surfaceAlt,
                                        opacity: pressed || ratingBusy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <ThumbsUp color={palette.text} size={32} />
                            </Pressable>
                            <Pressable
                                onPress={() => handleRate(null)}
                                disabled={ratingBusy}
                                style={({ pressed }) => [
                                    styles.skipButton,
                                    { opacity: pressed || ratingBusy ? 0.6 : 1 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Skip
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={() => handleRate('down')}
                                disabled={ratingBusy}
                                style={({ pressed }) => [
                                    styles.thumbButton,
                                    {
                                        backgroundColor: palette.surfaceAlt,
                                        opacity: pressed || ratingBusy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <ThumbsDown color={palette.text} size={32} />
                            </Pressable>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

function CloseButton({
    top,
    bg,
    fg,
    onPress,
}: {
    top: number;
    bg: string;
    fg: string;
    onPress: () => void;
}) {
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.sm}
            style={[styles.closeButton, { top, backgroundColor: bg }]}
        >
            <X color={fg} size={20} />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: { alignItems: 'center', justifyContent: 'center' },
    scrollContent: { paddingBottom: spacing.xxl },
    backdropContainer: {
        width: '100%',
        height: BACKDROP_HEIGHT,
    },
    backdrop: {
        width: '100%',
        height: '100%',
    },
    backdropGradient: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: BACKDROP_HEIGHT / 2,
    },
    titleBlock: {
        flexDirection: 'row',
        gap: spacing.base,
        paddingHorizontal: spacing.base,
        marginTop: -POSTER_HEIGHT / 2,
    },
    poster: {
        width: POSTER_WIDTH,
        height: POSTER_HEIGHT,
        borderRadius: radius.sm,
    },
    titleText: {
        flex: 1,
        gap: spacing.xs,
        justifyContent: 'flex-end',
        paddingBottom: spacing.sm,
    },
    tagline: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    genres: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    genrePill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.full,
    },
    overview: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.base,
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
    },
    actionButton: {
        flex: 1,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    closeButton: {
        position: 'absolute',
        left: spacing.base,
        width: 36,
        height: 36,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    sheetBackdrop: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
    },
    sheetTitle: {
        textAlign: 'center',
        marginBottom: spacing.lg,
    },
    sheetActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-evenly',
        paddingVertical: spacing.sm,
    },
    thumbButton: {
        width: 64,
        height: 64,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
    },
});
