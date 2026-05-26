import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Send, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { RatingSheet } from '@/components/rating-sheet';
import { applyWatchedRating, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type ItemStatus = 'watchlist' | 'watching' | 'watched';

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

interface Sender {
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

// Rec attribution shown above the backdrop whenever this title has been
// recommended to the current user. `senders` is the deduped list of
// recommenders (ordered by most recent rec first); `totalCount` matches
// senders.length but is kept distinct in case we later cap the displayed
// list. `note` is set only when arrived via ?fromRec=<id> — that param
// pins which rec's note to surface; without it the senders are shown
// without a quoted note.
interface RecContext {
    senders: Sender[];
    totalCount: number;
    note: string | null;
}

function firstName(displayName: string): string {
    const trimmed = displayName.trim();
    const first = trimmed.split(/\s+/)[0];
    return first || trimmed || 'A friend';
}

function formatSenderLine(senders: Sender[]): string {
    if (senders.length === 0) return '';
    const names = senders.map((s) => firstName(s.displayName));
    if (names.length === 1) {
        return `${names[0]} recommended this to you`;
    }
    if (names.length === 2) {
        return `${names[0]} & ${names[1]} recommended this to you`;
    }
    const others = names.length - 2;
    return `${names[0]}, ${names[1]} & ${others} other${
        others === 1 ? '' : 's'
    } recommended this to you`;
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
    // Existing items.rating, if any. Drives the RatingSheet's
    // initialRating so re-rates land on the user's previous pick.
    const [currentRating, setCurrentRating] = useState<number | null>(null);
    const [updating, setUpdating] = useState(false);
    const [showRatingSheet, setShowRatingSheet] = useState(false);
    const [ratingBusy, setRatingBusy] = useState(false);
    const [recContext, setRecContext] = useState<RecContext | null>(null);

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
                        .select('status, rating')
                        .eq('user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle();
                    if (!active) return;
                    if (item && STATUSES.includes(item.status as ItemStatus)) {
                        setCurrentStatus(item.status as ItemStatus);
                    }
                    if (item && typeof item.rating === 'number') {
                        setCurrentRating(item.rating);
                    }
                }

                // Always-on rec attribution: load every recommendation this
                // user has received for this title (any non-dismissed
                // status — pending / accepted / watched) and surface the
                // sender list. The fromRec query param, when present, just
                // pins which rec's note to display below the senders;
                // without it we show senders without a note. Failures here
                // are silent — the rest of the screen renders fine.
                if (userId) {
                    const { data: recRows, error: recsError } = await supabase
                        .from('recommendations')
                        .select('from_user_id, sent_at')
                        .eq('to_user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .in('status', ['pending', 'accepted', 'watched'])
                        .order('sent_at', { ascending: false });
                    if (recsError) {
                        console.warn('rec context fetch failed:', recsError);
                    } else if (active && recRows && recRows.length > 0) {
                        // Dedup senders (a single sender might appear twice
                        // if they re-sent after a dismiss — rare but cheap
                        // to guard) preserving the most-recent-first order.
                        const senderIds: string[] = [];
                        const seenIds = new Set<string>();
                        for (const row of recRows) {
                            const sid = row.from_user_id;
                            if (!sid || seenIds.has(sid)) continue;
                            seenIds.add(sid);
                            senderIds.push(sid);
                        }

                        let senders: Sender[] = [];
                        if (senderIds.length > 0) {
                            const { data: profileRows } = await supabase
                                .from('profiles')
                                .select('id, handle, display_name, avatar_url')
                                .in('id', senderIds);
                            const profileById = new Map(
                                (profileRows ?? []).map((p) => [p.id, p]),
                            );
                            senders = senderIds
                                .map((id) => profileById.get(id))
                                .filter(
                                    (
                                        p,
                                    ): p is {
                                        id: string;
                                        handle: string;
                                        display_name: string;
                                        avatar_url: string | null;
                                    } => !!p,
                                )
                                .map((p) => ({
                                    handle: p.handle,
                                    displayName: p.display_name,
                                    avatarUrl: p.avatar_url,
                                }));
                        }

                        // Note from the specific rec we arrived via, if any.
                        let note: string | null = null;
                        if (fromRec) {
                            const { data: pinnedRec } = await supabase
                                .from('recommendations')
                                .select('note')
                                .eq('id', fromRec)
                                .maybeSingle();
                            note = pinnedRec?.note ?? null;
                        }

                        if (active && senders.length > 0) {
                            setRecContext({
                                senders,
                                totalCount: senders.length,
                                note,
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
    // transition. Database writes (items.rating, matching-rec status
    // transitions) are delegated to applyWatchedRating in lib/rating.
    async function handleRate(rating: number | null) {
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

            await applyWatchedRating({ userId, tmdbId, mediaType, rating });
            // Track locally so a subsequent re-rate pre-fills the sheet.
            // Skip (rating === null) leaves the previous value alone —
            // applyWatchedRating doesn't clear it on the items row.
            if (rating !== null) setCurrentRating(rating);
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
                            avatarUrl={recContext.senders[0].avatarUrl}
                            displayName={recContext.senders[0].displayName}
                            size={36}
                        />
                        <View style={styles.recContextText}>
                            <Text
                                style={[typography.caption, { color: palette.text }]}
                                numberOfLines={2}
                            >
                                {formatSenderLine(recContext.senders)}
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

                {/* Status pills — a choice. The selected status is
                    filled accent; the others are outline-only with a
                    muted border so they read as "available options",
                    distinct from the primary Recommend action below. */}
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
                                        borderColor: isActive
                                            ? palette.accent
                                            : palette.border,
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
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {STATUS_LABELS[status]}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>

                {/* Recommend — a primary outgoing action. Filled accent
                    (vs. the outlined status pills above) so the visual
                    hierarchy reads "pick where this sits in your
                    library, then send it to a friend". */}
                <Pressable
                    onPress={() =>
                        router.push(`/title/${mediaType}/${tmdbId}/recommend`)
                    }
                    style={({ pressed }) => [
                        styles.recommendButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Send
                        color={palette.textInverse}
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
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

            <RatingSheet
                visible={showRatingSheet}
                busy={ratingBusy}
                initialRating={currentRating}
                onSubmit={handleRate}
            />
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
            <X color={fg} size={20} strokeWidth={ICON_STROKE_WIDTH} />
        </Pressable>
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
        // Filled accent — the border that lived here when the button
        // was outlined is gone; the background colour now defines the
        // edge.
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: spacing.base,
        marginTop: spacing.md,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
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
});
