import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Send, Star, X } from 'lucide-react-native';
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

import { Avatar } from '@/components/avatar';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

type MediaType = 'movie' | 'tv';
type ItemStatus = 'watchlist' | 'watching' | 'watched';
type RatingThumb = 'up' | 'down';

// items.rating stores the 1-5 value directly. The recommendations table
// still carries a coarser rating_thumb (up | down) as the credibility
// signal between friends — derived from the star value: 1-2 = down,
// 3-5 = up. Skipping (rating === null) leaves both untouched on items
// but still marks any matching open recs as watched.
function thumbFromRating(rating: number): RatingThumb {
    return rating <= 2 ? 'down' : 'up';
}

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

interface RecContext {
    note: string | null;
    sender: {
        handle: string;
        displayName: string;
        avatarUrl: string | null;
    };
}

export default function TitleDetailScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
        fromRec?: string;
    }>();
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
    const fromRec = typeof params.fromRec === 'string' ? params.fromRec : null;

    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentStatus, setCurrentStatus] = useState<ItemStatus | null>(null);
    const [updating, setUpdating] = useState(false);
    const [showRatingSheet, setShowRatingSheet] = useState(false);
    const [ratingBusy, setRatingBusy] = useState(false);
    const [recContext, setRecContext] = useState<RecContext | null>(null);
    // Drives the fill-on-press preview: when the user is mid-press on the
    // 4th star, stars 1-4 fill. Cleared on press-out and after dismiss.
    const [pressedRating, setPressedRating] = useState<number | null>(null);

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

                // If we arrived from the inbox via ?fromRec=<id>, load the
                // recommendation + sender so we can render the "Sarah
                // recommended this" card above the backdrop. Failures here
                // are silent — the rest of the screen renders fine.
                if (fromRec) {
                    const { data: rec, error: recError } = await supabase
                        .from('recommendations')
                        .select('from_user_id, note')
                        .eq('id', fromRec)
                        .maybeSingle();
                    if (recError) {
                        console.warn('rec context fetch failed:', recError);
                    } else if (active && rec?.from_user_id) {
                        const { data: senderProfile } = await supabase
                            .from('profiles')
                            .select('handle, display_name, avatar_url')
                            .eq('id', rec.from_user_id)
                            .maybeSingle();
                        if (active && senderProfile) {
                            setRecContext({
                                note: rec.note,
                                sender: {
                                    handle: senderProfile.handle,
                                    displayName: senderProfile.display_name,
                                    avatarUrl: senderProfile.avatar_url,
                                },
                            });
                        }
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
    }, [mediaType, tmdbId, fromRec]);

    async function setStatus(newStatus: ItemStatus) {
        // Block re-entry: while a status update is in flight, or while the
        // rating sheet is already open / its network call is mid-air,
        // ignore further taps.
        if (updating || ratingBusy || showRatingSheet || !mediaType) return;

        // Re-tapping Watched while already watched is meaningful — it
        // reopens the rating sheet so the user can change their stars.
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

    // Apply a 1-5 star rating (or skip with `null`) after a watched
    // transition. Updates items.rating when a value was chosen, and always
    // transitions any matching open recommendations (pending | accepted)
    // into `watched` — which fires the rec_watched notification trigger
    // for the sender. rating_thumb on the rec is derived from the star
    // value (1-2 = down, 3-5 = up) only when the user chose a rating;
    // skipping leaves it null.
    async function handleRate(rating: number | null) {
        if (ratingBusy || !mediaType) return;
        setRatingBusy(true);
        // Close the sheet immediately so the UI doesn't trap the user
        // behind a spinner if the network is slow. Errors surface via
        // Alert; success is silent.
        setShowRatingSheet(false);
        setPressedRating(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            if (rating !== null) {
                const { error: itemError } = await supabase
                    .from('items')
                    .update({ rating })
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
                if (rating !== null) update.rating_thumb = thumbFromRating(rating);

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
                {recContext && (
                    <View
                        style={[
                            styles.recContextCard,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    >
                        <Avatar
                            avatarUrl={recContext.sender.avatarUrl}
                            displayName={recContext.sender.displayName}
                            size={36}
                        />
                        <View style={styles.recContextText}>
                            <Text
                                style={[typography.caption, { color: palette.text }]}
                                numberOfLines={2}
                            >
                                <Text style={typography.bodyEmphasis}>
                                    {recContext.sender.displayName}
                                </Text>{' '}
                                recommended this to you
                            </Text>
                            {recContext.note && (
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.recContextNote,
                                        { color: palette.textMuted },
                                    ]}
                                    numberOfLines={3}
                                >
                                    “{recContext.note}”
                                </Text>
                            )}
                        </View>
                    </View>
                )}

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

                <Pressable
                    onPress={() =>
                        router.push(`/title/${mediaType}/${tmdbId}/recommend`)
                    }
                    style={({ pressed }) => [
                        styles.recommendButton,
                        {
                            borderColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Send color={palette.accent} size={18} />
                    <Text style={[typography.bodyEmphasis, { color: palette.accent }]}>
                        Recommend to a friend
                    </Text>
                </Pressable>
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
                        <StarRow
                            pressedRating={pressedRating}
                            onPressIn={setPressedRating}
                            onPressOut={() => setPressedRating(null)}
                            onPress={handleRate}
                            disabled={ratingBusy}
                            fillColor={palette.accent}
                            outlineColor={palette.textMuted}
                        />
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

// Row of 5 tappable stars. Press-in/press-out preview the fill so the
// user sees their selection before lifting off; commit fires on release
// via onPress.
function StarRow({
    pressedRating,
    onPressIn,
    onPressOut,
    onPress,
    disabled,
    fillColor,
    outlineColor,
}: {
    pressedRating: number | null;
    onPressIn: (rating: number) => void;
    onPressOut: () => void;
    onPress: (rating: number) => void;
    disabled: boolean;
    fillColor: string;
    outlineColor: string;
}) {
    return (
        <View style={styles.starsRow}>
            {[1, 2, 3, 4, 5].map((value) => {
                const filled = pressedRating !== null && value <= pressedRating;
                const color = filled ? fillColor : outlineColor;
                return (
                    <Pressable
                        key={value}
                        onPressIn={() => onPressIn(value)}
                        onPressOut={onPressOut}
                        onPress={() => onPress(value)}
                        disabled={disabled}
                        hitSlop={spacing.xs}
                        style={({ pressed }) => [
                            styles.starButton,
                            { opacity: pressed || disabled ? 0.6 : 1 },
                        ]}
                    >
                        <Star
                            color={color}
                            fill={filled ? fillColor : 'transparent'}
                            size={36}
                        />
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: { alignItems: 'center', justifyContent: 'center' },
    scrollContent: { paddingBottom: spacing.xxl },
    recContextCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginHorizontal: spacing.base,
        marginTop: spacing.md,
        marginBottom: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        borderRadius: radius.md,
    },
    recContextText: {
        flex: 1,
        gap: spacing.xs,
    },
    recContextNote: {
        fontStyle: 'italic',
    },
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
    recommendButton: {
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: spacing.base,
        marginTop: spacing.md,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
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
    starsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
    },
    starButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.sm,
    },
});
