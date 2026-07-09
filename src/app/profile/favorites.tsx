import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { GripVertical, Plus, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import DraggableFlatList, {
    type DragEndParams,
    type RenderItemParams,
} from 'react-native-draggable-flatlist';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    OnboardingSearch,
    type SearchableItem,
} from '@/components/onboarding-search';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { RatingSheet } from '@/components/rating-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { useProfile } from '@/hooks/use-profile';
import {
    addFavoriteAtRank,
    type FavoriteItem,
    fetchFavoritesForUser,
    removeFavorite,
    reorderFavorites,
    type UserFavorites,
} from '@/lib/favorites';
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

// Coerce an unknown thrown value into a user-presentable string.
// PostgrestError (the shape supabase-js throws from .from(...) chains)
// is a plain object with .message / .code / .hint / .details — NOT an
// Error instance, so the naive `err instanceof Error ? err.message :
// 'Unknown error'` pattern that lived at every catch site here was
// always falling through to "Unknown error" for any DB-level failure.
// Same duck-typed shape the title screen's surfaceUpdateError uses.
// Includes the PG code (e.g. "23505") when present so a constraint
// violation surfaces unambiguously in the alert without diving into
// Metro — load-bearing during the next iteration of the favorites
// editor when constraint behaviour might still surprise us.
function formatErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (
        err &&
        typeof err === 'object' &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
    ) {
        const obj = err as {
            message: string;
            code?: unknown;
            hint?: unknown;
        };
        const code =
            typeof obj.code === 'string' && obj.code.length > 0
                ? obj.code
                : null;
        const hint =
            typeof obj.hint === 'string' && obj.hint.length > 0
                ? obj.hint
                : null;
        const head = code ? `${code}: ${obj.message}` : obj.message;
        return hint ? `${head}\n\n${hint}` : head;
    }
    return 'Unknown error';
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

// True if the rank-sorted items array isn't 1, 2, 3, ... N — i.e. a
// removal has left a gap (e.g. 1, 3, 4) before the renormalize-on-
// remove flow landed in this build, or the slot was never compacted.
// Drives the opportunistic compaction in the initial load effect.
function hasRankGap(items: FavoriteItem[]): boolean {
    return items.some((f, i) => f.rank !== i + 1);
}

// ---------------------------------------------------------------------------
// Combined-list cell model. The editor renders BOTH Top-5 sections through a
// single DraggableFlatList so a swipe over any row scrolls the page and only a
// grip long-press starts a reorder (the Nestable variants let each section's
// inner drag pan swallow scroll swipes over rows). Films + shows are flattened
// into one stream: each section contributes a header, then its item rows (or
// an empty-state cell), then an add affordance. Only 'item' cells are
// draggable; the 'header' markers are what handleDragEnd uses to detect (and
// reject) cross-section moves.
// ---------------------------------------------------------------------------
type FavoriteCell =
    | { key: string; type: 'header'; mediaType: MediaCategory }
    | { key: string; type: 'item'; mediaType: MediaCategory; fav: FavoriteItem }
    | { key: string; type: 'empty'; mediaType: MediaCategory }
    | { key: string; type: 'add'; mediaType: MediaCategory };

function buildCells(favorites: UserFavorites): FavoriteCell[] {
    const cells: FavoriteCell[] = [];
    for (const mediaType of ['movie', 'tv'] as const) {
        const list = mediaType === 'movie' ? favorites.movies : favorites.tv;
        cells.push({ key: `header:${mediaType}`, type: 'header', mediaType });
        if (list.length === 0) {
            cells.push({ key: `empty:${mediaType}`, type: 'empty', mediaType });
        } else {
            for (const fav of list) {
                cells.push({
                    key: `item:${mediaType}:${fav.id}`,
                    type: 'item',
                    mediaType,
                    fav,
                });
            }
        }
        cells.push({ key: `add:${mediaType}`, type: 'add', mediaType });
    }
    return cells;
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
    const showLoader = useDeferredLoading(loading);
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

    // Refresh local favorites state from the server. Retries once on
    // transient failure (mirrors callProxy's silent-retry shape — most
    // network blips resolve on the second try). If BOTH attempts fail,
    // THROWS — the previous "swallow + console.warn" shape let local
    // state drift out of sync with the DB after a failed refresh, and
    // subsequent operations (nextOpenRank, the duplicate pre-check)
    // computed against stale data and intermittently collided on
    // INSERT. Now the failure surfaces to the caller's catch, which
    // shows the actual error via formatErrorMessage rather than letting
    // staleness accumulate silently.
    //
    // Callers that don't want a refresh-failure to abort their flow
    // (e.g. the optimistic-rollback path in handleReorderEnd) wrap
    // this call in their own try/catch.
    const refreshFavorites = useCallback(async () => {
        if (!userId) return;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const result = await fetchFavoritesForUser(userId);
                setFavorites(result);
                return;
            } catch (err) {
                lastError = err;
                if (attempt === 0) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, 400),
                    );
                }
            }
        }
        console.error('favorites refresh failed after retry:', lastError);
        throw lastError;
    }, [userId]);

    useEffect(() => {
        let active = true;
        (async () => {
            if (!userId) return;
            try {
                const result = await fetchFavoritesForUser(userId);
                if (!active) return;
                // Opportunistic gap compaction. A pre-3b build that
                // removed a slot without renumbering would leave gaps
                // (e.g. 1, 3, 4 if rank 2 was removed). Detect those
                // here and call reorder_favorites with the current
                // ordering so they renumber 1..N before render.
                // Best-effort: any failure here leaves the gaps in
                // place (load still completes); the renumber retries
                // on next editor visit.
                const moviesNeedCompact = hasRankGap(result.movies);
                const tvNeedCompact = hasRankGap(result.tv);
                if (moviesNeedCompact || tvNeedCompact) {
                    try {
                        if (moviesNeedCompact) {
                            await reorderFavorites({
                                mediaType: 'movie',
                                orderedIds: result.movies.map((f) => f.id),
                            });
                        }
                        if (tvNeedCompact) {
                            await reorderFavorites({
                                mediaType: 'tv',
                                orderedIds: result.tv.map((f) => f.id),
                            });
                        }
                        // Re-fetch to pick up the renumbered ranks.
                        const compacted =
                            await fetchFavoritesForUser(userId);
                        if (active) setFavorites(compacted);
                    } catch (compactErr) {
                        console.warn(
                            'opportunistic compaction failed (rendering with gaps):',
                            compactErr,
                        );
                        if (active) setFavorites(result);
                    }
                } else {
                    setFavorites(result);
                }
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
            // Refetch favorites from the DB BEFORE any decision —
            // don't trust local state for the duplicate-tmdb pre-check
            // OR for nextOpenRank's slot computation. Either being
            // stale (e.g. after a previously-failed silent refresh)
            // would let an INSERT into a stale-thought-open rank
            // collide on favorites_user_media_rank_unique, or let a
            // duplicate tmdb_id slip past the pre-check and collide
            // on favorites_user_media_tmdb_unique. The cost is one
            // extra round-trip per add; the alternative (the previous
            // local-state read) was the intermittent "Couldn't add"
            // bug. Same setFavorites so the screen reflects the
            // freshest state before the writes start.
            const fresh = await fetchFavoritesForUser(userId);
            setFavorites(fresh);
            const list = mediaType === 'movie' ? fresh.movies : fresh.tv;
            const titleText =
                item.media_type === 'movie' ? item.title : item.name;

            // Pre-check (against FRESH list, not local state): tmdb_id
            // already in this category at a DIFFERENT rank than the
            // one we're replacing? The other UNIQUE on (user_id,
            // media_type, tmdb_id) would fire on the INSERT otherwise.
            // Catch it here with a friendlier message.
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
                    backdropPath: item.backdrop_path,
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
                formatErrorMessage(err),
            );
        } finally {
            setBusy(false);
        }
    }

    // ------------------------------------------------------------------
    // Reorder flow (drag-to-reorder on drop)
    // ------------------------------------------------------------------

    async function handleReorderEnd(
        mediaType: MediaCategory,
        newOrder: FavoriteItem[],
    ) {
        if (busy) return;
        const currentList =
            mediaType === 'movie' ? favorites.movies : favorites.tv;
        const newIds = newOrder.map((f) => f.id);
        const currentIds = currentList.map((f) => f.id);
        // Skip the round-trip if the drop ended at the same position
        // (drag started but didn't actually move anything).
        if (
            newIds.length === currentIds.length &&
            newIds.every((id, i) => id === currentIds[i])
        ) {
            return;
        }
        setBusy(true);
        // Optimistic update: write the new order + new ranks into
        // local state so the row doesn't snap back to its old position
        // during the network round-trip. Re-derived as { ...f, rank: i+1 }
        // so the rank chips on the cards match the new ordering
        // immediately. Reverted by refreshFavorites() in the catch
        // branch if the RPC fails.
        setFavorites((prev) => ({
            ...prev,
            [mediaType === 'movie' ? 'movies' : 'tv']: newOrder.map(
                (f, i) => ({ ...f, rank: i + 1 }),
            ),
        }));
        try {
            await reorderFavorites({ mediaType, orderedIds: newIds });
            await refreshFavorites();
        } catch (err) {
            console.error('favorites reorder failed:', err);
            Alert.alert(
                "Couldn't reorder",
                formatErrorMessage(err),
            );
            // Roll back optimistic update on failure. Wrapped in its
            // own try/catch because refreshFavorites now throws on
            // failure (previously swallowed) — a rollback-refresh
            // failure shouldn't supersede the original reorder error
            // that's already in the alert. Worst case here: local
            // state stays at the optimistic ordering, but the user
            // already saw the "Couldn't reorder" alert and can retry.
            try {
                await refreshFavorites();
            } catch (refreshErr) {
                console.warn(
                    'refresh during reorder-rollback failed:',
                    refreshErr,
                );
            }
        } finally {
            setBusy(false);
        }
    }

    // onDragEnd for the combined list. Only item cells are draggable, but a
    // drag can still DROP an item across the section divider (a film dragged
    // down into the shows block, or vice versa). Films and shows are two
    // separate Top-5 lists, so a cross-section move is invalid. We detect it
    // by walking the reordered cells IN ORDER, tracking the section of the
    // most recent header marker: any item whose mediaType doesn't match the
    // current header's section (or that appears before any header) means the
    // drag crossed the divider → reject and snap back to the server order.
    // On a valid within-section reorder only the one section that actually
    // changed is persisted (a single drag moves one item within one section);
    // handleReorderEnd no-ops the unchanged section and skips the round-trip.
    function handleDragEnd({ data }: DragEndParams<FavoriteCell>) {
        let section: MediaCategory | null = null;
        const next: Record<MediaCategory, FavoriteItem[]> = {
            movie: [],
            tv: [],
        };
        for (const cell of data) {
            if (cell.type === 'header') {
                section = cell.mediaType;
            } else if (cell.type === 'item') {
                if (section === null || cell.mediaType !== section) {
                    // Cross-section drag — not allowed. Re-fetch to restore
                    // the row to its original section and order (same rollback
                    // path handleReorderEnd uses on RPC failure).
                    void refreshFavorites();
                    return;
                }
                next[cell.mediaType].push(cell.fav);
            }
            // 'empty' / 'add' cells don't participate in ordering.
        }
        // Exactly one section can change per drag; persist only that one.
        const changed = (['movie', 'tv'] as const).find((m) => {
            const before = (m === 'movie' ? favorites.movies : favorites.tv)
                .map((f) => f.id)
                .join(',');
            return before !== next[m].map((f) => f.id).join(',');
        });
        if (changed) void handleReorderEnd(changed, next[changed]);
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
            // Compact the gap left by the removed rank: re-rank the
            // remaining favorites in this category in their current
            // order. Skipped when nothing remains (the RPC's n=0
            // branch is a no-op anyway, but skipping the round-trip
            // is cheaper). After the renumber, refresh once — the
            // refresh picks up both the DELETE and the new ranks in
            // one round-trip.
            const remaining = (favorite.mediaType === 'movie'
                ? favorites.movies
                : favorites.tv
            ).filter((f) => f.id !== favorite.id);
            if (remaining.length > 0) {
                await reorderFavorites({
                    mediaType: favorite.mediaType,
                    orderedIds: remaining.map((f) => f.id),
                });
            }
            await refreshFavorites();
        } catch (err) {
            console.error('favorites remove failed:', err);
            Alert.alert(
                "Couldn't remove",
                formatErrorMessage(err),
            );
        } finally {
            setBusy(false);
        }
    }

    // ------------------------------------------------------------------
    // Rating flow — same shape as the title screen's handleRate.
    // ------------------------------------------------------------------

    // The RatingSheet now owns persistence (rating + rec transitions); here we
    // only close the sheet.
    function handleRatingSubmit() {
        setPendingRating(null);
    }

    // ------------------------------------------------------------------
    // Render helpers
    // ------------------------------------------------------------------

    // Per-row renderer for DraggableFlatList. Long-press the grip
    // handle (≡) on the left to start dragging; the rest of the row is
    // tap-inert except the [×] remove on the right. `drag` is the
    // function the library hands us to begin a drag; we bind it to
    // the grip's onLongPress (not the whole row) so the [×] tap stays
    // a clean affordance with no gesture conflict. `isActive` is true
    // while THIS row is being dragged — we dim its opacity so the
    // user sees clearly which row is in motion.
    function renderDraggableRow(
        fav: FavoriteItem,
        drag: () => void,
        isActive: boolean,
    ) {
        return (
            <View
                style={[
                    styles.row,
                    styles.cellRow,
                    { borderColor: palette.border },
                    isActive && { opacity: 0.7 },
                ]}
            >
                <Pressable
                    onLongPress={drag}
                    delayLongPress={150}
                    disabled={busy}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Drag to reorder ${fav.title || 'this title'}`}
                    style={({ pressed }) => [
                        styles.rowDragHandle,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <GripVertical
                        color={palette.textMuted}
                        size={20}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
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
                            { backgroundColor: palette.surfaceAlt },
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
        );
    }

    // The combined list renders four cell kinds. Only 'item' cells wire
    // `drag` (to the grip, inside renderDraggableRow); headers, the
    // empty-state and the add button are inert markers.
    function renderCell({
        item,
        drag,
        isActive,
    }: RenderItemParams<FavoriteCell>) {
        switch (item.type) {
            case 'header':
                return renderSectionHeader(item.mediaType);
            case 'empty':
                return renderSectionEmpty(item.mediaType);
            case 'add':
                return renderSectionAdd(item.mediaType);
            case 'item':
                return renderDraggableRow(item.fav, drag, isActive);
        }
    }

    function renderSectionHeader(mediaType: MediaCategory) {
        const list = mediaType === 'movie' ? favorites.movies : favorites.tv;
        return (
            <View style={[styles.sectionHeading, styles.cellHeader]}>
                <Text style={[typography.bodyEmphasis, { color: palette.text }]}>
                    Top {MAX_RANK} {categoryLabel(mediaType)}
                </Text>
                <Text style={[typography.caption, { color: palette.textMuted }]}>
                    {list.length}/{MAX_RANK}
                </Text>
            </View>
        );
    }

    function renderSectionEmpty(mediaType: MediaCategory) {
        return (
            <Text
                style={[
                    typography.caption,
                    styles.sectionEmpty,
                    styles.cellEmpty,
                    { color: palette.textMuted },
                ]}
            >
                No {singularLabel(mediaType)}s yet — add up to {MAX_RANK}.
            </Text>
        );
    }

    // Single "+ Add" affordance per section. When full, triggers the
    // replace picker; when not full, opens search directly. Both paths
    // land in handleSearchPick via setSearchOpen.
    function renderSectionAdd(mediaType: MediaCategory) {
        const list = mediaType === 'movie' ? favorites.movies : favorites.tv;
        const isFull = list.length >= MAX_RANK;
        return (
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
                    styles.cellAdd,
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
                <Text style={[typography.bodyEmphasis, { color: palette.accent }]}>
                    {isFull
                        ? `Replace a ${singularLabel(mediaType)}`
                        : `Add ${singularLabel(mediaType)}`}
                </Text>
            </Pressable>
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

    const cells = buildCells(favorites);

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Edit Top 5" showBackButton />
            {showLoader ? (
                <FullScreenLoader />
            ) : (
                // One combined DraggableFlatList (not the Nestable variants).
                // The Nestable pair put each section's drag pan INSIDE an
                // outer scroll container; that inner pan claimed vertical
                // swipes over rows (activeOffsetY) and blocked the outer
                // scroll, so only the gap between sections scrolled. A single
                // self-scrolling DraggableFlatList owns both the scroll and
                // the drag in one gesture tree, so a swipe over a row scrolls
                // and only a grip long-press starts a reorder. Films + shows
                // are flattened into one cell stream (buildCells); handleDragEnd
                // re-segments by header marker and rejects cross-section moves.
                <DraggableFlatList
                    data={cells}
                    keyExtractor={(cell) => cell.key}
                    onDragEnd={handleDragEnd}
                    activationDistance={10}
                    contentContainerStyle={[
                        styles.scrollContent,
                        // scrollContent's static paddingBottom doesn't clear the
                        // home-indicator safe area: the root View is flex:1 with
                        // no bottom inset, so the list runs to the physical screen
                        // edge and the last cell (the Shows add/replace button)
                        // sits partly under the safe area. Fold insets.bottom in
                        // on top of the xxl breathing room so it scrolls fully
                        // into view. (Overrides scrollContent.paddingBottom.)
                        { paddingBottom: insets.bottom + spacing.xxl + spacing.lg },
                    ]}
                    renderItem={renderCell}
                />
            )}

            {/* Search modal — full-screen overlay containing the
                reusable OnboardingSearch component with a mediaType
                filter pinned to the section the user is editing.
                Uses insets.top directly (not <SafeAreaView>) because a
                React Native <Modal> renders OUTSIDE the
                SafeAreaProvider tree on iOS — the SafeAreaView wrapper
                doesn't receive the right insets there and ends up flush
                against Y=0, colliding with the status bar. The
                useSafeAreaInsets hook itself still returns the
                provider's values when called from this component (it
                captures them at hook time), so applying paddingTop
                manually does the right thing inside the Modal. The
                rest of the app's full-screen surfaces are stack routes
                with presentation: 'modal' (see _layout.tsx), where
                SafeAreaView works normally — that's the preferred
                pattern; this Modal stays for state-management
                simplicity in the editor. */}
            <Modal
                visible={searchOpen !== null}
                animationType="slide"
                onRequestClose={() => setSearchOpen(null)}
            >
                {searchOpen && (
                    <View
                        style={[
                            styles.modalRoot,
                            {
                                backgroundColor: palette.bg,
                                paddingTop: insets.top,
                            },
                        ]}
                    >
                        <View style={styles.modalHeader}>
                            <Text
                                style={[
                                    typography.heading,
                                    styles.modalHeaderTitle,
                                    { color: palette.text },
                                ]}
                                numberOfLines={1}
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
                    </View>
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
                            {
                                backgroundColor: palette.overlay,
                                paddingBottom: insets.bottom + spacing.lg,
                            },
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
                tmdbId={pendingRating?.tmdbId ?? null}
                mediaType={pendingRating?.mediaType ?? null}
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
    },
    // Per-cell vertical rhythm for the combined DraggableFlatList — the
    // library doesn't apply contentContainerStyle `gap` cleanly between
    // its cells, so each cell carries its own trailing margin instead.
    cellHeader: { marginBottom: spacing.md }, // header → first row
    cellRow: { marginBottom: spacing.sm }, // row → row
    cellEmpty: { marginBottom: spacing.md }, // empty-state → add
    cellAdd: { marginBottom: spacing.xl }, // add → next section header
    sectionHeading: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
    },
    sectionEmpty: {
        paddingVertical: spacing.sm,
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
    rowDragHandle: {
        // Drag-handle tap target on the LEFT of the row. Long-press
        // starts the drag (see renderDraggableRow). Slightly wider
        // than the icon so the hit area is comfortable for
        // imprecise touches.
        paddingHorizontal: spacing.xs,
        paddingVertical: spacing.xs,
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
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        // gap (not justifyContent: 'space-between') because the title
        // has flex: 1 and naturally takes all available space, pushing
        // Cancel to the right edge. gap guarantees breathing room
        // between them even when the title ellipsises.
        gap: spacing.md,
    },
    modalHeaderTitle: {
        // flex: 1 + numberOfLines={1} on the <Text> means a long title
        // (e.g. "Replace rank N" plus future copy growth) ellipsises
        // instead of pushing into the Cancel button.
        flex: 1,
    },
    modalBody: {
        flex: 1,
    },
    modalBodyContent: {
        paddingHorizontal: spacing.base,
        paddingBottom: spacing.lg,
    },
    replaceBackdrop: {
        // backgroundColor set inline in the JSX (palette.overlay) —
        // overlay is theme-dependent and palette isn't in scope at
        // StyleSheet.create time.
        flex: 1,
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
