import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Plus, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    OnboardingSearch,
    type SearchableItem,
} from '@/components/onboarding-search';
import { RatingSheet } from '@/components/rating-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { useProfile } from '@/hooks/use-profile';
import {
    addFavoriteAtRank,
    type FavoriteItem,
    fetchFavoritesForUser,
    removeFavorite,
    type UserFavorites,
} from '@/lib/favorites';
import { applyWatchedRating } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { ensureTitle } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type MediaCategory = 'movie' | 'tv';

const MAX_RANK = 5;

// Open state for the search modal. `replacingRank` non-null means we're
// in the replace-an-existing-slot flow (set after the user picked which
// rank to replace via the replacePicker modal); null means it's a
// plain add to the lowest-empty rank.
interface SearchOpenState {
    mediaType: MediaCategory;
    replacingRank: number | null;
}

// Pending rating sheet target. Mirrors the title screen's pattern —
// after marking something watched, fire the same RatingSheet over the
// editor. Skip / cancel writes nothing (matches title-screen behaviour);
// a chosen rating goes through applyWatchedRating so the rec-status
// transitions + rating_thumb derivation it does stay consistent.
interface PendingRatingState {
    tmdbId: number;
    mediaType: MediaCategory;
    currentRating: number | null;
}

function nextOpenRank(items: FavoriteItem[]): number {
    const used = new Set(items.map((f) => f.rank));
    for (let r = 1; r <= MAX_RANK; r++) {
        if (!used.has(r)) return r;
    }
    // Caller's responsibility — the editor screen guards on
    // items.length < MAX_RANK before calling.
    throw new Error('nextOpenRank: no open rank');
}

function categoryLabel(mediaType: MediaCategory): string {
    return mediaType === 'movie' ? 'Films' : 'Shows';
}

function singularLabel(mediaType: MediaCategory): string {
    return mediaType === 'movie' ? 'film' : 'show';
}

// Promise-wrapped Alert.alert for the watched-status confirmation. The
// caller awaits the user's choice — Yes resumes the add flow, No (or
// dismissal) cancels it. Returning a boolean keeps the flow linear
// instead of breaking it into onPress callbacks.
function confirmMarkWatched(title: string): Promise<boolean> {
    return new Promise((resolve) => {
        Alert.alert(
            "Mark as watched?",
            `You haven't marked ${title || 'this title'} as watched. Adding it to your top 5 will mark it watched.`,
            [
                {
                    text: 'Cancel',
                    style: 'cancel',
                    onPress: () => resolve(false),
                },
                {
                    text: 'Mark watched',
                    onPress: () => resolve(true),
                },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
}

function confirmRemove(title: string): Promise<boolean> {
    return new Promise((resolve) => {
        Alert.alert(
            'Remove from your top 5?',
            title || undefined,
            [
                {
                    text: 'Cancel',
                    style: 'cancel',
                    onPress: () => resolve(false),
                },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: () => resolve(true),
                },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
}

export default function EditFavoritesScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { profile } = useProfile();
    const userId = profile?.id ?? null;

    const [favorites, setFavorites] = useState<UserFavorites>({
        movies: [],
        tv: [],
    });
    const [loading, setLoading] = useState(true);
    // `busy` blocks re-entry during the add/remove flow (pick a title,
    // run the items lookup, run the upsert, etc.). A single bool covers
    // every mutation — the user can't usefully start a second mutation
    // before the first finishes, and modals already prevent most
    // accidental double-tapping.
    const [busy, setBusy] = useState(false);
    const [searchOpen, setSearchOpen] = useState<SearchOpenState | null>(null);
    const [replacePicker, setReplacePicker] = useState<{
        mediaType: MediaCategory;
    } | null>(null);
    const [pendingRating, setPendingRating] = useState<PendingRatingState | null>(
        null,
    );
    const [ratingBusy, setRatingBusy] = useState(false);

    const refreshFavorites = useCallback(async () => {
        if (!userId) return;
        try {
            const result = await fetchFavoritesForUser(userId);
            setFavorites(result);
        } catch (err) {
            console.warn('favorites refresh failed:', err);
            // Soft failure — keep showing whatever we last loaded.
        }
    }, [userId]);

    useEffect(() => {
        let active = true;
        (async () => {
            if (!userId) return;
            try {
                const result = await fetchFavoritesForUser(userId);
                if (active) setFavorites(result);
            } catch (err) {
                console.warn('initial favorites load failed:', err);
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [userId]);

    // ------------------------------------------------------------------
    // Add flow
    // ------------------------------------------------------------------

    function handleAddTapped(mediaType: MediaCategory) {
        if (busy) return;
        const list = mediaType === 'movie' ? favorites.movies : favorites.tv;
        if (list.length >= MAX_RANK) {
            // Full → ask which to replace BEFORE opening search (so the
            // user knows the slot they're filling before committing to
            // a title).
            setReplacePicker({ mediaType });
        } else {
            setSearchOpen({ mediaType, replacingRank: null });
        }
    }

    function handleReplaceSlotPicked(rank: number) {
        if (!replacePicker) return;
        const mediaType = replacePicker.mediaType;
        setReplacePicker(null);
        // Now open search with this rank pinned as the replacement
        // target.
        setSearchOpen({ mediaType, replacingRank: rank });
    }

    async function handleSearchPick(item: SearchableItem) {
        if (!userId || !searchOpen || busy) return;
        const { mediaType, replacingRank } = searchOpen;
        setSearchOpen(null);
        setBusy(true);

        try {
            const list = mediaType === 'movie' ? favorites.movies : favorites.tv;
            const titleText =
                item.media_type === 'movie' ? item.title : item.name;

            // Pre-check: tmdb_id already in this category at a DIFFERENT
            // rank than the one we're replacing? The other UNIQUE on
            // (user_id, media_type, tmdb_id) would fire on the UPSERT
            // otherwise. Catch it here with a friendlier message.
            const existing = list.find((f) => f.tmdbId === item.id);
            if (existing) {
                if (
                    replacingRank !== null &&
                    existing.rank === replacingRank
                ) {
                    // "Replacing" with the same title at the same rank
                    // — silent no-op.
                    return;
                }
                Alert.alert(
                    'Already in your top 5',
                    `${titleText} is at rank ${existing.rank} in your Top 5 ${categoryLabel(mediaType)}.`,
                );
                return;
            }

            // Items lookup — drives the watched-status branches.
            const { data: existingItem, error: itemsLookupError } = await supabase
                .from('items')
                .select('status, rating')
                .eq('user_id', userId)
                .eq('tmdb_id', item.id)
                .eq('media_type', mediaType)
                .maybeSingle();
            if (itemsLookupError) {
                throw itemsLookupError;
            }

            const currentStatus = existingItem?.status as
                | 'watchlist'
                | 'watching'
                | 'watched'
                | undefined;
            const currentRating =
                typeof existingItem?.rating === 'number'
                    ? existingItem.rating
                    : null;

            let needsRatingSheet = false;

            if (!currentStatus) {
                // Not in library at all — implicit consent (adding to
                // top 5 means "I love this," so we silently stamp the
                // items row as watched + the catalogue row).
                const rawDate =
                    item.media_type === 'movie'
                        ? item.release_date
                        : item.first_air_date;
                void ensureTitle({
                    tmdbId: item.id,
                    mediaType,
                    title: titleText,
                    posterPath: item.poster_path,
                    releaseDate:
                        typeof rawDate === 'string' && rawDate.length > 0
                            ? rawDate
                            : null,
                    originalLanguage: item.original_language,
                    genreIds: item.genre_ids,
                });
                const { error: upsertErr } = await supabase
                    .from('items')
                    .upsert(
                        {
                            user_id: userId,
                            tmdb_id: item.id,
                            media_type: mediaType,
                            status: 'watched',
                            watched_at: new Date().toISOString(),
                        },
                        { onConflict: 'user_id,tmdb_id,media_type' },
                    );
                if (upsertErr) throw upsertErr;
                needsRatingSheet = true;
            } else if (currentStatus !== 'watched') {
                // In library at watchlist/watching — confirm the
                // status transition explicitly. Cancelling the prompt
                // cancels the WHOLE add (no favorites row, no items
                // change), per spec.
                const confirmed = await confirmMarkWatched(titleText);
                if (!confirmed) return;
                const { error: upsertErr } = await supabase
                    .from('items')
                    .upsert(
                        {
                            user_id: userId,
                            tmdb_id: item.id,
                            media_type: mediaType,
                            status: 'watched',
                            watched_at: new Date().toISOString(),
                        },
                        { onConflict: 'user_id,tmdb_id,media_type' },
                    );
                if (upsertErr) throw upsertErr;
                needsRatingSheet = true;
            }
            // else status === 'watched' — no items change, no rating
            // sheet (rating happens at watched-transition time, not
            // afterwards).

            // Determine target rank: replacingRank when set, else
            // lowest open. Re-derive list (state hasn't changed since
            // entering this handler, but be explicit about it).
            const targetRank =
                replacingRank !== null ? replacingRank : nextOpenRank(list);

            await addFavoriteAtRank({
                userId,
                mediaType,
                tmdbId: item.id,
                rank: targetRank,
            });

            await refreshFavorites();

            if (needsRatingSheet) {
                // Fire the SAME rating flow the title screen uses —
                // RatingSheet component + applyWatchedRating handler.
                // Pre-fills with the previous rating (null for
                // first-time watch) so re-rates land on the prior
                // pick.
                setPendingRating({
                    tmdbId: item.id,
                    mediaType,
                    currentRating,
                });
            }
        } catch (err) {
            console.error('favorites add failed:', err);
            Alert.alert(
                "Couldn't add",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    // ------------------------------------------------------------------
    // Remove flow
    // ------------------------------------------------------------------

    async function handleRemoveTapped(favorite: FavoriteItem) {
        if (busy) return;
        const confirmed = await confirmRemove(favorite.title);
        if (!confirmed) return;
        setBusy(true);
        try {
            await removeFavorite(favorite.id);
            await refreshFavorites();
        } catch (err) {
            console.error('favorites remove failed:', err);
            Alert.alert(
                "Couldn't remove",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    // ------------------------------------------------------------------
    // Rating flow — same shape as the title screen's handleRate.
    // ------------------------------------------------------------------

    async function handleRatingSubmit(rating: number | null) {
        const target = pendingRating;
        // Close the sheet immediately so the UI doesn't trap behind a
        // spinner if the network is slow (mirrors the title screen).
        setPendingRating(null);
        if (!target || !userId) return;
        if (rating === null) return; // skip
        setRatingBusy(true);
        try {
            await applyWatchedRating({
                userId,
                tmdbId: target.tmdbId,
                mediaType: target.mediaType,
                rating,
            });
        } catch (err) {
            console.error('favorites rating update failed:', err);
            Alert.alert(
                'Rating update failed',
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setRatingBusy(false);
        }
    }

    // ------------------------------------------------------------------
    // Render helpers
    // ------------------------------------------------------------------

    function renderSection(mediaType: MediaCategory) {
        const list = mediaType === 'movie' ? favorites.movies : favorites.tv;
        const isFull = list.length >= MAX_RANK;
        return (
            <View style={styles.section}>
                <View style={styles.sectionHeading}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                    >
                        Top {MAX_RANK} {categoryLabel(mediaType)}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                    >
                        {list.length}/{MAX_RANK}
                    </Text>
                </View>

                {list.length === 0 ? (
                    <Text
                        style={[
                            typography.caption,
                            styles.sectionEmpty,
                            { color: palette.textMuted },
                        ]}
                    >
                        No {singularLabel(mediaType)}s yet — add up to {MAX_RANK}.
                    </Text>
                ) : (
                    <View style={styles.rows}>
                        {list.map((fav) => (
                            <View
                                key={fav.id}
                                style={[
                                    styles.row,
                                    { borderColor: palette.border },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        styles.rowRank,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    {fav.rank}
                                </Text>
                                {fav.posterPath ? (
                                    <Image
                                        source={{
                                            uri: imageUrl(fav.posterPath, 'w185'),
                                        }}
                                        style={styles.rowPoster}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                ) : (
                                    <View
                                        style={[
                                            styles.rowPoster,
                                            {
                                                backgroundColor:
                                                    palette.surfaceAlt,
                                            },
                                        ]}
                                    />
                                )}
                                <Text
                                    style={[
                                        typography.body,
                                        styles.rowTitle,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={2}
                                >
                                    {fav.title || 'Untitled'}
                                </Text>
                                <Pressable
                                    onPress={() => handleRemoveTapped(fav)}
                                    hitSlop={spacing.sm}
                                    disabled={busy}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Remove ${fav.title || 'this title'} from your top 5`}
                                    style={({ pressed }) => [
                                        styles.rowRemove,
                                        pressed && { opacity: 0.6 },
                                    ]}
                                >
                                    <X
                                        color={palette.textMuted}
                                        size={20}
                                        strokeWidth={ICON_STROKE_WIDTH}
                                    />
                                </Pressable>
                            </View>
                        ))}
                    </View>
                )}

                {/* Single "+ Add" affordance per section. When full,
                    triggers the replace picker; when not full, opens
                    search directly. Both paths land in handleSearchPick
                    via setSearchOpen. */}
                <Pressable
                    onPress={() => handleAddTapped(mediaType)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={
                        isFull
                            ? `Replace a ${singularLabel(mediaType)} in your top 5`
                            : `Add a ${singularLabel(mediaType)} to your top 5`
                    }
                    style={({ pressed }) => [
                        styles.addButton,
                        {
                            borderColor: palette.border,
                            opacity: pressed || busy ? 0.6 : 1,
                        },
                    ]}
                >
                    <Plus
                        color={palette.accent}
                        size={18}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.accent }]}
                    >
                        {isFull
                            ? `Replace a ${singularLabel(mediaType)}`
                            : `Add ${singularLabel(mediaType)}`}
                    </Text>
                </Pressable>
            </View>
        );
    }

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    if (!userId) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader title="Edit Top 5" showBackButton />
                <View style={styles.fillCenter}>
                    <Text style={[typography.body, { color: palette.error }]}>
                        Profile not available
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Edit Top 5" showBackButton />
            {loading ? (
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            ) : (
                <ScrollView contentContainerStyle={styles.scrollContent}>
                    {renderSection('movie')}
                    {renderSection('tv')}
                </ScrollView>
            )}

            {/* Search modal — full-screen overlay containing the
                reusable OnboardingSearch component with a mediaType
                filter pinned to the section the user is editing. */}
            <Modal
                visible={searchOpen !== null}
                animationType="slide"
                onRequestClose={() => setSearchOpen(null)}
            >
                {searchOpen && (
                    <SafeAreaView
                        style={[
                            styles.modalRoot,
                            { backgroundColor: palette.bg },
                        ]}
                        edges={['top']}
                    >
                        <View style={styles.modalHeader}>
                            <Text
                                style={[typography.heading, { color: palette.text }]}
                            >
                                {searchOpen.replacingRank !== null
                                    ? `Replace rank ${searchOpen.replacingRank}`
                                    : `Add ${singularLabel(searchOpen.mediaType)}`}
                            </Text>
                            <Pressable
                                onPress={() => setSearchOpen(null)}
                                hitSlop={spacing.sm}
                                accessibilityRole="button"
                                accessibilityLabel="Cancel"
                                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Cancel
                                </Text>
                            </Pressable>
                        </View>
                        <ScrollView
                            style={styles.modalBody}
                            contentContainerStyle={styles.modalBodyContent}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                        >
                            <OnboardingSearch
                                placeholder={`Search ${searchOpen.mediaType === 'movie' ? 'films' : 'shows'}`}
                                onPick={handleSearchPick}
                                mediaType={searchOpen.mediaType}
                            />
                        </ScrollView>
                    </SafeAreaView>
                )}
            </Modal>

            {/* Replace picker — fires when "+ Add" is tapped on a full
                category. Centered transparent modal listing the five
                current entries; tap a row to set replacingRank and
                advance to the search modal. */}
            <Modal
                visible={replacePicker !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setReplacePicker(null)}
            >
                {replacePicker && (
                    <Pressable
                        style={[
                            styles.replaceBackdrop,
                            { paddingBottom: insets.bottom + spacing.lg },
                        ]}
                        onPress={() => setReplacePicker(null)}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel replace"
                    >
                        {/* Inner Pressable absorbs taps so a tap on the
                            card itself doesn't bubble to the backdrop
                            and close the picker. */}
                        <Pressable
                            style={[
                                styles.replaceCard,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: palette.border,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.heading,
                                    styles.replaceTitle,
                                    { color: palette.text },
                                ]}
                            >
                                Your top 5 is full
                            </Text>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Tap one to replace.
                            </Text>
                            <View style={styles.replaceList}>
                                {(replacePicker.mediaType === 'movie'
                                    ? favorites.movies
                                    : favorites.tv
                                ).map((fav) => (
                                    <Pressable
                                        key={fav.id}
                                        onPress={() =>
                                            handleReplaceSlotPicked(fav.rank)
                                        }
                                        style={({ pressed }) => [
                                            styles.replaceRow,
                                            { borderColor: palette.border },
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.bodyEmphasis,
                                                styles.rowRank,
                                                { color: palette.textMuted },
                                            ]}
                                        >
                                            {fav.rank}
                                        </Text>
                                        {fav.posterPath ? (
                                            <Image
                                                source={{
                                                    uri: imageUrl(
                                                        fav.posterPath,
                                                        'w185',
                                                    ),
                                                }}
                                                style={styles.rowPoster}
                                                contentFit="cover"
                                                transition={150}
                                            />
                                        ) : (
                                            <View
                                                style={[
                                                    styles.rowPoster,
                                                    {
                                                        backgroundColor:
                                                            palette.surfaceAlt,
                                                    },
                                                ]}
                                            />
                                        )}
                                        <Text
                                            style={[
                                                typography.body,
                                                styles.rowTitle,
                                                { color: palette.text },
                                            ]}
                                            numberOfLines={2}
                                        >
                                            {fav.title || 'Untitled'}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                            <Pressable
                                onPress={() => setReplacePicker(null)}
                                hitSlop={spacing.sm}
                                style={({ pressed }) => [
                                    styles.replaceCancel,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Cancel
                                </Text>
                            </Pressable>
                        </Pressable>
                    </Pressable>
                )}
            </Modal>

            {/* Rating sheet — the SAME component the title screen uses
                when marking something watched. Fires after a new add
                that included a status transition; doesn't fire when
                the title was already watched (rating happens at the
                watched-transition moment, not afterwards). */}
            <RatingSheet
                visible={pendingRating !== null}
                busy={ratingBusy}
                initialRating={pendingRating?.currentRating ?? null}
                onSubmit={handleRatingSubmit}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    scrollContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.xxl,
        gap: spacing.xl,
    },
    section: {
        gap: spacing.md,
    },
    sectionHeading: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
    },
    sectionEmpty: {
        paddingVertical: spacing.sm,
    },
    rows: {
        gap: spacing.sm,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
    },
    rowRank: {
        // Fixed width so misaligned rank numbers (1-5 single digit)
        // don't drift the poster column.
        width: 18,
        textAlign: 'center',
    },
    rowPoster: {
        width: 40,
        height: 60,
        borderRadius: radius.sm,
    },
    rowTitle: {
        flex: 1,
    },
    rowRemove: {
        padding: spacing.xs,
    },
    addButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderStyle: 'dashed',
    },
    modalRoot: { flex: 1 },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
    },
    modalBody: {
        flex: 1,
    },
    modalBodyContent: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.lg,
    },
    replaceBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'flex-end',
        paddingHorizontal: spacing.base,
    },
    replaceCard: {
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        padding: spacing.lg,
        gap: spacing.md,
    },
    replaceTitle: {
        // No extra margin — the parent's gap handles spacing.
    },
    replaceList: {
        gap: spacing.sm,
    },
    replaceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
    },
    replaceCancel: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
