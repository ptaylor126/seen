import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
    ChevronLeft,
    MessageSquarePlus,
    MoreVertical,
    Search as SearchIcon,
    Send,
    UserPlus,
    X,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    FlatList,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { SegmentedControl } from '@/components/segmented-control';
import { TopFiveSections } from '@/components/top-five-sections';
import { ViewControls } from '@/components/view-controls';
import { fetchFavoritesForUser, type UserFavorites } from '@/lib/favorites';
import {
    type LibraryGridCols,
    useLibraryView,
} from '@/lib/library-view';
import { TMDB_GENRE_NAMES } from '@/lib/genres';
import { formatRatingStars, type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import {
    ensureTitle,
    type EnsureTitleArgs,
    fetchTitlesByItems,
    type TitleRow,
} from '@/lib/titles';
import { getMovie, getTV, imageUrl } from '@/lib/tmdb';
import { useLibraryFilters } from '@/lib/use-library-filters';
import { LibraryFilterControls } from '@/components/library-filter-controls';
import { RequestRecSheet } from '@/components/request-rec-sheet';
import { useRequestRec } from '@/hooks/use-request-rec';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type ItemStatus = 'watchlist' | 'watching' | 'watched';

interface FriendProfile {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

interface ItemRow {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    rating: number | null;
    watchedAt: string | null;
    createdAt: string;
    title: string;
    posterPath: string | null;
    year: string;
    originalLanguage: string | null;
    genreIds: number[] | null;
}

// One rec in the "Recs between you" strip — either direction. `direction`
// is from the current user's POV: 'sent' = I recommended it to this friend,
// 'received' = they recommended it to me (drives the "From you" / "From
// {name}" caption). posterPath comes from the titles catalogue (TMDB
// fallback for uncatalogued titles).
interface RecBetween {
    recId: string;
    tmdbId: number;
    mediaType: MediaType;
    posterPath: string | null;
    direction: 'sent' | 'received';
}

// One written review by this friend, for the "Recent reviews" strip.
// Ordered by when the REVIEW was written/updated (reviews.updated_at), not
// the watch date. spoiler-flagged reviews show a "contains spoilers"
// placeholder instead of the body (the reveal flow lives on the title
// page). rating is the friend's items.rating for the title, if any.
interface RecentReview {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    body: string;
    containsSpoilers: boolean;
    rating: number | null;
}

// Fetch poster/title metadata for a set of (tmdb_id, media_type) from the
// shared catalogue, filling any missing rows via a direct TMDB fetch (and
// stamping them forward with ensureTitle) — the same fallback the home
// screen uses, so a rec'd/reviewed title that was never added to anyone's
// library still renders. Used by both the recs-between and recent-reviews
// strips. Returns the populated key→row map.
async function fetchTitlesWithFallback(
    items: { tmdb_id: number; media_type: string }[],
): Promise<Map<string, TitleRow>> {
    const titleByKey = await fetchTitlesByItems(items);
    const missing = new Map<string, { tmdbId: number; mediaType: MediaType }>();
    for (const it of items) {
        const key = `${it.media_type}:${it.tmdb_id}`;
        if (titleByKey.has(key)) continue;
        if (it.media_type !== 'movie' && it.media_type !== 'tv') continue;
        missing.set(key, { tmdbId: it.tmdb_id, mediaType: it.media_type });
    }
    if (missing.size === 0) return titleByKey;
    const fetched = await Promise.all(
        Array.from(missing.values()).map(
            async (m): Promise<EnsureTitleArgs | null> => {
                try {
                    if (m.mediaType === 'movie') {
                        const mv = await getMovie(m.tmdbId);
                        return {
                            tmdbId: m.tmdbId,
                            mediaType: 'movie',
                            title: mv.title,
                            posterPath: mv.poster_path,
                            backdropPath: mv.backdrop_path,
                            releaseDate:
                                mv.release_date && mv.release_date.length > 0
                                    ? mv.release_date
                                    : null,
                            originalLanguage: mv.original_language,
                            genreIds: mv.genres.map((g) => g.id),
                        };
                    }
                    const tv = await getTV(m.tmdbId);
                    return {
                        tmdbId: m.tmdbId,
                        mediaType: 'tv',
                        title: tv.name,
                        posterPath: tv.poster_path,
                        backdropPath: tv.backdrop_path,
                        releaseDate:
                            tv.first_air_date && tv.first_air_date.length > 0
                                ? tv.first_air_date
                                : null,
                        originalLanguage: tv.original_language,
                        genreIds: tv.genres.map((g) => g.id),
                    };
                } catch (err) {
                    console.warn('title TMDB fallback failed:', err);
                    return null;
                }
            },
        ),
    );
    for (const s of fetched) {
        if (!s) continue;
        titleByKey.set(`${s.mediaType}:${s.tmdbId}`, {
            tmdb_id: s.tmdbId,
            media_type: s.mediaType,
            title: s.title,
            poster_path: s.posterPath,
            backdrop_path: s.backdropPath,
            release_date: s.releaseDate,
            original_language: s.originalLanguage,
            genre_ids: s.genreIds,
        });
        void ensureTitle(s);
    }
    return titleByKey;
}

// Three-state resolution machine. Renders the whole screen off this:
//   - loading → spinner
//   - not-found → handle resolves to no profile (or fetch failed)
//   - not-friends → profile exists but no friendship row
//   - friends → full library view
type ResolvedState =
    | { kind: 'loading' }
    | { kind: 'not-found' }
    | { kind: 'not-friends'; profile: FriendProfile }
    | { kind: 'friends'; profile: FriendProfile; friendshipCreatedAt: string };

const TABS: readonly ItemStatus[] = ['watchlist', 'watching', 'watched'] as const;
const TAB_LABELS: Record<ItemStatus, string> = {
    watchlist: 'Watchlist',
    watching: 'Watching',
    watched: 'Watched',
};
// Stable {value, label} array for the shared SegmentedControl —
// computed once at module scope so the prop reference doesn't change
// across renders.
const TAB_OPTIONS: ReadonlyArray<{ value: ItemStatus; label: string }> =
    TABS.map((value) => ({ value, label: TAB_LABELS[value] }));

const POSTER_W = 56;
const POSTER_H = 84;
const AVATAR_SIZE = 80;

// Grid sizing — mirrors the Library tab so a friend's grid looks
// identical to your own at the same density setting. Kept locally
// rather than imported so this screen stays a self-contained route;
// the numbers would only diverge if the Library tweaks them, and
// noticing that drift on review is fine.
const POSTER_ASPECT = 1.5; // 2:3 poster

// "Recs between you" strip. Poster width is derived from screen width so
// ~3.5 cards show and the next is HALF-CUT at the right edge — a clear
// "scrolls horizontally" cue on any device (same trick as the home
// "Friends are watching" row). A fixed width tiled flush to the edge and
// read as a static row. REC_STRIP_INSET/GAP must match the strip styles
// below (leading inset + inter-card gap) for the peek math to hold.
const RECS_BETWEEN_LIMIT = 20;
// Recent reviews is a header overview, not a full archive — cap it so the
// (already busy) profile header stays bounded.
const RECENT_REVIEWS_LIMIT = 3;
const REVIEW_POSTER_W = 48;
const REVIEW_POSTER_H = Math.round(REVIEW_POSTER_W * 1.5);
const REVIEW_SNIPPET_CHARS = 180;
const REC_STRIP_INSET = spacing.base;
const REC_STRIP_GAP = spacing.md;
const REC_BETWEEN_POSTER_W = Math.floor(
    (Dimensions.get('window').width - REC_STRIP_INSET - 3 * REC_STRIP_GAP) / 3.5,
);
const REC_BETWEEN_POSTER_H = Math.round(REC_BETWEEN_POSTER_W * POSTER_ASPECT);
const GRID_GAP_BY_COLS: Record<LibraryGridCols, number> = {
    2: spacing.base,
    3: spacing.sm,
    4: spacing.sm,
};

function getGridCellWidth(cols: LibraryGridCols, screenWidth: number): number {
    const gap = GRID_GAP_BY_COLS[cols];
    const usable = screenWidth - 2 * spacing.base;
    return Math.floor((usable - (cols - 1) * gap) / cols);
}

// The whole screen is one FlatList so the profile header can scroll away
// while the filter zone (tabs + filters) sticks. Its data is a tagged
// union: a single 'filters' row (sticky), then the library body as either
// one 'listRow' per item (list mode) or one 'gridRow' per row-of-cells
// (grid mode — FlatList's numColumns is incompatible with
// stickyHeaderIndices, so we chunk into rows ourselves).
type LibraryListItem =
    | { type: 'filters' }
    | { type: 'listRow'; row: ItemRow }
    | { type: 'gridRow'; rows: ItemRow[] };

// Leading-star variant — "★4.5" reads tighter at small chip sizes than
// the trailing-star "4.5★" used in list rows. Mirrors the Library tab.
function compactRatingStars(rating: number): string {
    return `★${rating / 2}`;
}

// "Friends since May 2026" — a single coarse line is enough; specific
// days feel surveillance-y for a casual social product.
function formatFriendsSince(iso: string): string {
    const d = new Date(iso);
    const month = d.toLocaleString('en-US', { month: 'long' });
    return `Friends since ${month} ${d.getFullYear()}`;
}

function emptyMessage(status: ItemStatus, displayName: string): string {
    switch (status) {
        case 'watchlist':
            return `${displayName} hasn't added anything to their watchlist yet.`;
        case 'watching':
            return `${displayName} isn't currently watching anything.`;
        case 'watched':
            return `${displayName} hasn't marked anything watched yet.`;
    }
}

export default function FriendDetailScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const requestRec = useRequestRec();
    const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
    // Handles are stored lowercase in the DB (per the handle column's
    // CHECK constraint). Defensively coerce the URL param so that a
    // capitalized link from somewhere still resolves.
    const handle = (rawHandle ?? '').toLowerCase();

    const [state, setState] = useState<ResolvedState>({ kind: 'loading' });
    const [activeTab, setActiveTab] = useState<ItemStatus>('watched');
    const [items, setItems] = useState<ItemRow[]>([]);
    const [itemsLoading, setItemsLoading] = useState(false);
    const [itemsError, setItemsError] = useState<string | null>(null);
    // Friend's top 5 lists. RLS gates the read at the DB layer (favorites
    // SELECT policy is owner-or-friend); calling this for a non-friend
    // would return an empty array, not throw — but the loader effect
    // below only fires when state.kind === 'friends' anyway.
    // Focus state + ref for the local search field — drives the
    // Cancel-on-focus affordance (mirrors Home's SearchBarInput
    // pattern). The ref is needed so Cancel can blur the input
    // directly rather than fall back to Keyboard.dismiss() (which
    // doesn't update RN's tracked focus on Android).
    const localSearchInputRef = useRef<TextInput | null>(null);
    const [localFocused, setLocalFocused] = useState(false);
    const [favorites, setFavorites] = useState<UserFavorites>({
        movies: [],
        tv: [],
    });
    // Recommendation history between the current user and this friend, both
    // directions, most-recent first. null = not yet loaded / none → the
    // "Recs between you" strip is hidden.
    const [recsBetween, setRecsBetween] = useState<RecBetween[] | null>(null);
    // This friend's recently-written reviews (text reviews, newest review
    // first). null = not yet loaded / none → the section is hidden.
    const [recentReviews, setRecentReviews] = useState<RecentReview[] | null>(
        null,
    );
    // In-flight guard for the "Remove friend" action (overflow menu).
    const [removing, setRemoving] = useState(false);

    // Shared filter / sort / search state — same hook the own library
    // (src/app/(tabs)/library.tsx) uses, so the two screens stay in
    // lockstep. Called at the top so the hook is invoked
    // unconditionally regardless of the resolution state below; when
    // items is still [] (loading / not-found / not-friends branches),
    // the hook's memos return empty arrays and its effects no-op.
    const filters = useLibraryFilters<ItemRow>(items, activeTab);

    // Global library view mode (persisted via AsyncStorage). Switching
    // here updates the same setting Library tab reads from — flipping
    // grid/list on a friend's profile changes it on your own library
    // too. Density (gridCols) is part of the same shared setting.
    const { mode, gridCols, setMode, setGridCols } = useLibraryView();
    const screenWidth = Dimensions.get('window').width;

    // ---- Phase 1: resolve friend by handle + friendship status.
    // useFocusEffect so we re-resolve on return (e.g. user accepted a
    // request elsewhere and came back). Stale-guard via `active`.
    useFocusEffect(
        useCallback(() => {
            if (!handle) {
                setState({ kind: 'not-found' });
                return;
            }
            let active = true;
            (async () => {
                try {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    const userId = session?.user.id;
                    if (!userId) throw new Error('Not authenticated');

                    const { data: profileData, error: profileError } =
                        await supabase
                            .from('profiles')
                            .select('id, display_name, handle, avatar_url')
                            .eq('handle', handle)
                            .maybeSingle();
                    if (!active) return;
                    if (profileError) throw profileError;
                    if (!profileData) {
                        setState({ kind: 'not-found' });
                        return;
                    }

                    // Looking at your own handle via this route — bounce
                    // to the proper profile tab instead of rendering an
                    // awkward "you're not friends with yourself" page.
                    if (profileData.id === userId) {
                        router.replace('/(tabs)/profile');
                        return;
                    }

                    const profile: FriendProfile = {
                        id: profileData.id,
                        handle: profileData.handle,
                        displayName: profileData.display_name,
                        avatarUrl: profileData.avatar_url,
                    };

                    // Friendships are stored with (least, greatest) so we
                    // can use a direct primary-key match instead of an
                    // OR query.
                    const least = userId < profile.id ? userId : profile.id;
                    const greatest = userId > profile.id ? userId : profile.id;
                    const { data: friendship, error: friendshipError } =
                        await supabase
                            .from('friendships')
                            .select('created_at')
                            .eq('user_a_id', least)
                            .eq('user_b_id', greatest)
                            .maybeSingle();
                    if (!active) return;
                    if (friendshipError) throw friendshipError;

                    if (!friendship) {
                        setState({ kind: 'not-friends', profile });
                        return;
                    }

                    setState({
                        kind: 'friends',
                        profile,
                        friendshipCreatedAt: friendship.created_at,
                    });
                } catch (err) {
                    if (!active) return;
                    console.error('friend profile resolve failed:', err);
                    // We don't differentiate transient errors from genuine
                    // misses here — "not found" is the safest user-facing
                    // landing for an unresolvable handle.
                    setState({ kind: 'not-found' });
                }
            })();
            return () => {
                active = false;
            };
        }, [handle, router]),
    );

    // ---- Phase 2: fetch items for the active tab (only when friends).
    // visibility is filtered both client-side (explicit) and by RLS
    // (defence in depth); RLS is the authoritative check.
    useEffect(() => {
        if (state.kind !== 'friends') return;
        let active = true;
        setItemsLoading(true);
        setItemsError(null);
        (async () => {
            try {
                const { data: rows, error } = await supabase
                    .from('items')
                    .select('id, tmdb_id, media_type, rating, watched_at, updated_at, created_at')
                    .eq('user_id', state.profile.id)
                    .eq('status', activeTab)
                    .eq('visibility', 'friends')
                    .order('updated_at', { ascending: false });
                // .limit(100) removed (step 4 parity work): the cap
                // would silently truncate filter / sort / genre
                // results to "the first 100 by recency", which is
                // wrong now that filtering moved client-side. Items
                // rows are small (~80 bytes); the titles join is
                // already batched. Alpha-scale safe.
                if (!active) return;
                if (error) throw error;

                // Stage 4: pull title metadata from the shared
                // public.titles catalogue in one batched query (down
                // from N per-item TMDB calls). Missing key → empty
                // strings + null poster, the same placeholder shape
                // the prior per-item TMDB-failure path landed on.
                const titleByKey = await fetchTitlesByItems(rows ?? []);
                if (!active) return;
                const resolved: ItemRow[] = (rows ?? []).map((r) => {
                    const titleRow = titleByKey.get(
                        `${r.media_type}:${r.tmdb_id}`,
                    );
                    return {
                        id: r.id,
                        tmdbId: r.tmdb_id,
                        mediaType: r.media_type as MediaType,
                        rating: typeof r.rating === 'number' ? r.rating : null,
                        watchedAt: r.watched_at,
                        createdAt: r.created_at,
                        title: titleRow?.title ?? '',
                        posterPath: titleRow?.poster_path ?? null,
                        year: titleRow?.release_date
                            ? titleRow.release_date.slice(0, 4)
                            : '',
                        originalLanguage: titleRow?.original_language ?? null,
                        genreIds: titleRow?.genre_ids ?? null,
                    };
                });
                setItems(resolved);
            } catch (err) {
                if (!active) return;
                console.error('friend items fetch failed:', err);
                setItemsError(
                    err instanceof Error ? err.message : 'Failed to load',
                );
            } finally {
                if (active) setItemsLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [state, activeTab]);

    // ---- Phase 2b: fetch the friend's top 5 lists. Separate from the
    // items effect because it doesn't depend on activeTab (tab switches
    // would needlessly re-fetch). Best-effort: a transient read failure
    // degrades to "no top 5 shown," not a broken profile screen.
    useEffect(() => {
        if (state.kind !== 'friends') {
            setFavorites({ movies: [], tv: [] });
            return;
        }
        let active = true;
        (async () => {
            try {
                const result = await fetchFavoritesForUser(state.profile.id);
                if (active) setFavorites(result);
            } catch (err) {
                console.warn('friend favorites fetch failed:', err);
            }
        })();
        return () => {
            active = false;
        };
    }, [state]);

    // ---- Phase 2c: recommendation history between the two users (both
    // directions). Best-effort: a failure degrades to "no strip," not a
    // broken profile. RLS (recommendations_select_party: from = auth.uid()
    // OR to = auth.uid()) already returns both directions — every row here
    // has me as one party.
    useEffect(() => {
        if (state.kind !== 'friends') {
            setRecsBetween(null);
            return;
        }
        const friendId = state.profile.id;
        let active = true;
        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const me = session?.user.id;
                if (!me || !active) return;

                const { data: recRows, error: recErr } = await supabase
                    .from('recommendations')
                    .select('id, from_user_id, to_user_id, tmdb_id, media_type, sent_at')
                    .or(
                        `and(from_user_id.eq.${me},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${me})`,
                    )
                    .order('sent_at', { ascending: false })
                    .limit(RECS_BETWEEN_LIMIT);
                if (recErr) throw recErr;
                if (!active) return;
                const rows = recRows ?? [];
                if (rows.length === 0) {
                    setRecsBetween([]);
                    return;
                }

                // Poster metadata via the shared catalogue (+ TMDB fallback
                // for uncatalogued rec'd titles).
                const titleByKey = await fetchTitlesWithFallback(
                    rows.map((r) => ({
                        tmdb_id: r.tmdb_id,
                        media_type: r.media_type,
                    })),
                );
                if (!active) return;

                const built: RecBetween[] = rows.map((r) => ({
                    recId: r.id,
                    tmdbId: r.tmdb_id,
                    mediaType: r.media_type as MediaType,
                    posterPath:
                        titleByKey.get(`${r.media_type}:${r.tmdb_id}`)
                            ?.poster_path ?? null,
                    direction: r.from_user_id === me ? 'sent' : 'received',
                }));
                if (active) setRecsBetween(built);
            } catch (err) {
                console.warn('recs-between fetch failed:', err);
            }
        })();
        return () => {
            active = false;
        };
    }, [state]);

    // ---- Phase 2d: this friend's recently-WRITTEN reviews. Ordered by
    // reviews.updated_at (when the review was written/edited), NOT watch
    // date. RLS (reviews_select_own_or_visible_via_item) only returns
    // reviews whose parent items row is friends-visible — same privacy
    // model as the rest of the screen. Best-effort.
    useEffect(() => {
        if (state.kind !== 'friends') {
            setRecentReviews(null);
            return;
        }
        const friendId = state.profile.id;
        let active = true;
        (async () => {
            try {
                const { data: reviewRows, error: revErr } = await supabase
                    .from('reviews')
                    .select('tmdb_id, media_type, body, contains_spoilers, updated_at')
                    .eq('user_id', friendId)
                    .order('updated_at', { ascending: false })
                    .limit(RECENT_REVIEWS_LIMIT);
                if (revErr) throw revErr;
                if (!active) return;
                const rows = reviewRows ?? [];
                if (rows.length === 0) {
                    setRecentReviews([]);
                    return;
                }

                // Friend's rating per reviewed title (items.rating), keyed
                // by (media_type, tmdb_id). Same RLS as reviews — only
                // friends-visible items come back, which is exactly the set
                // whose reviews we can see.
                const tmdbIds = Array.from(new Set(rows.map((r) => r.tmdb_id)));
                const ratingByKey = new Map<string, number>();
                const { data: itemRows } = await supabase
                    .from('items')
                    .select('tmdb_id, media_type, rating')
                    .eq('user_id', friendId)
                    .in('tmdb_id', tmdbIds);
                for (const it of itemRows ?? []) {
                    if (typeof it.rating === 'number') {
                        ratingByKey.set(
                            `${it.media_type}:${it.tmdb_id}`,
                            it.rating,
                        );
                    }
                }

                const titleByKey = await fetchTitlesWithFallback(
                    rows.map((r) => ({
                        tmdb_id: r.tmdb_id,
                        media_type: r.media_type,
                    })),
                );
                if (!active) return;

                const built: RecentReview[] = rows.map((r) => {
                    const key = `${r.media_type}:${r.tmdb_id}`;
                    return {
                        tmdbId: r.tmdb_id,
                        mediaType: r.media_type as MediaType,
                        title: titleByKey.get(key)?.title ?? 'Untitled',
                        posterPath: titleByKey.get(key)?.poster_path ?? null,
                        body: r.body,
                        containsSpoilers: r.contains_spoilers,
                        rating: ratingByKey.get(key) ?? null,
                    };
                });
                if (active) setRecentReviews(built);
            } catch (err) {
                console.warn('recent reviews fetch failed:', err);
            }
        })();
        return () => {
            active = false;
        };
    }, [state]);

    function renderGridCell({ item }: { item: ItemRow }) {
        const cellWidth = getGridCellWidth(gridCols, screenWidth);
        const cellHeight = Math.floor(cellWidth * POSTER_ASPECT);
        const showRating = activeTab === 'watched' && item.rating !== null;
        return (
            <Pressable
                onPress={() =>
                    router.push({
                        pathname: '/title/[mediaType]/[tmdbId]',
                        params: {
                            mediaType: item.mediaType,
                            tmdbId: String(item.tmdbId),
                        },
                    })
                }
                style={({ pressed }) => [
                    { width: cellWidth, height: cellHeight },
                    styles.gridCell,
                    pressed && { opacity: 0.6 },
                ]}
                accessibilityLabel={item.title}
            >
                {item.posterPath ? (
                    <Image
                        source={{ uri: imageUrl(item.posterPath, 'w342') }}
                        style={[
                            styles.gridPoster,
                            { width: cellWidth, height: cellHeight },
                        ]}
                        contentFit="cover"
                        transition={150}
                    />
                ) : (
                    <View
                        style={[
                            styles.gridPoster,
                            {
                                width: cellWidth,
                                height: cellHeight,
                                backgroundColor: palette.surfaceAlt,
                            },
                        ]}
                    />
                )}
                {showRating && item.rating !== null ? (
                    <View
                        style={[
                            styles.gridRatingChip,
                            { backgroundColor: palette.bg },
                        ]}
                    >
                        <Text
                            style={[
                                styles.gridRatingText,
                                { color: palette.text },
                            ]}
                        >
                            {compactRatingStars(item.rating)}
                        </Text>
                    </View>
                ) : null}
            </Pressable>
        );
    }

    function renderRow({ item }: { item: ItemRow }) {
        const mediaLabel = item.mediaType === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [item.year, mediaLabel].filter(Boolean).join(' · ');
        const watchedDate = item.watchedAt
            ? new Date(item.watchedAt).toLocaleDateString()
            : '';
        const ratingDisplay =
            item.rating !== null ? formatRatingStars(item.rating) : '';
        const watchedLine = [ratingDisplay, watchedDate]
            .filter(Boolean)
            .join(' · ');
        const showWatchedLine = activeTab === 'watched' && watchedLine.length > 0;
        return (
            <Pressable
                onPress={() =>
                    router.push({
                        pathname: '/title/[mediaType]/[tmdbId]',
                        params: {
                            mediaType: item.mediaType,
                            tmdbId: String(item.tmdbId),
                        },
                    })
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                {item.posterPath ? (
                    <Image
                        source={{ uri: imageUrl(item.posterPath, 'w185') }}
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
                <View style={styles.rowText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {item.title}
                    </Text>
                    {metaLine ? (
                        <Text
                            style={[typography.caption, { color: palette.textMuted }]}
                        >
                            {metaLine}
                        </Text>
                    ) : null}
                    {showWatchedLine ? (
                        <Text
                            style={[typography.caption, { color: palette.textMuted }]}
                        >
                            {watchedLine}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    // ---- Render branches per state.

    const backButton = (
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
    );

    if (state.kind === 'loading') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            </SafeAreaView>
        );
    }

    if (state.kind === 'not-found') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.fillCenter}>
                    <Text
                        style={[
                            typography.heading,
                            styles.centerText,
                            { color: palette.text },
                        ]}
                    >
                        User not found
                    </Text>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        @{rawHandle ?? 'this handle'} doesn&apos;t exist on Seen.
                    </Text>
                </View>
            </SafeAreaView>
        );
    }

    if (state.kind === 'not-friends') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton}</View>
                <View style={styles.profileBlock}>
                    <Avatar
                        avatarUrl={state.profile.avatarUrl}
                        displayName={state.profile.displayName}
                        seedId={state.profile.id}
                        size={AVATAR_SIZE}
                    />
                    <Text
                        style={[typography.heading, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {state.profile.displayName}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                    >
                        @{state.profile.handle}
                    </Text>
                </View>
                <View style={styles.notFriendsBlock}>
                    <Text
                        style={[
                            typography.body,
                            styles.centerText,
                            { color: palette.textMuted },
                        ]}
                    >
                        You&apos;re not friends with @{state.profile.handle}. Add
                        them as a friend to see their library.
                    </Text>
                    <Pressable
                        onPress={() => router.push('/friends/add')}
                        style={({ pressed }) => [
                            styles.primaryButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <UserPlus
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
                            Add friend
                        </Text>
                    </Pressable>
                </View>
            </SafeAreaView>
        );
    }

    // ---- state.kind === 'friends'
    const { profile, friendshipCreatedAt } = state;

    // Remove friend — overflow menu → confirm → unfriend RPC (symmetric,
    // silent; the existing RPC sends no notification). On success (or a
    // benign "already gone" race) route to the Friends tab so we don't sit
    // on a profile mid-transition. Recs/threads/items are intentionally
    // kept by the RPC.
    async function performRemoveFriend() {
        if (removing) return;
        setRemoving(true);
        try {
            const { error } = await supabase.rpc('unfriend', {
                other_user_id: profile.id,
            });
            // 'friendship not found' = already removed (double-tap / removed
            // elsewhere) → treat as success and proceed to the post-removal
            // nav rather than erroring.
            if (error && !/friendship not found/i.test(error.message)) {
                throw error;
            }
            router.replace({ pathname: '/friends' });
        } catch (err) {
            console.error('remove friend failed:', err);
            setRemoving(false);
            Alert.alert('Could not remove friend', 'Please try again.');
        }
    }

    function confirmRemoveFriend() {
        const name = profile.displayName;
        Alert.alert(
            `Remove ${name} as a friend?`,
            "You'll no longer see each other's libraries or activity.",
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: () => void performRemoveFriend(),
                },
            ],
        );
    }

    function openFriendMenu() {
        if (removing) return;
        Alert.alert(`@${profile.handle}`, undefined, [
            {
                text: 'Remove friend',
                style: 'destructive',
                onPress: confirmRemoveFriend,
            },
            { text: 'Cancel', style: 'cancel' },
        ]);
    }

    // Body rows for the single scrolling FlatList. Grid mode is chunked
    // into rows of `gridCols` cells (numColumns can't coexist with the
    // sticky filter row); list mode is one item per row. The 'filters'
    // item is data[0] and sticks (stickyHeaderIndices below). Loading /
    // error / empty render in the footer so the sticky tabs stay visible.
    //
    // Crucially `showBody` does NOT gate on itemsLoading: switching tabs
    // refetches (the items query is per-status), and emptying the body
    // mid-fetch would collapse the list to just the sticky header and snap
    // scroll back to the top. Instead we keep the previous tab's rows
    // mounted until the new ones arrive (keep-previous-data), so scroll
    // position and the stuck tabs survive the swap. Only a genuine
    // first-load with no rows yet shows the spinner (see listFooter).
    const hasRows = filters.visibleRows.length > 0;
    const showBody = !itemsError && hasRows;
    const bodyItems: LibraryListItem[] = [];
    if (showBody) {
        if (mode === 'list') {
            for (const row of filters.visibleRows) {
                bodyItems.push({ type: 'listRow', row });
            }
        } else {
            for (let i = 0; i < filters.visibleRows.length; i += gridCols) {
                bodyItems.push({
                    type: 'gridRow',
                    rows: filters.visibleRows.slice(i, i + gridCols),
                });
            }
        }
    }
    const listData: LibraryListItem[] = [{ type: 'filters' }, ...bodyItems];

    // Profile info — scrolls away with the list (ListHeaderComponent).
    const listHeader = (
        <>
            <View style={styles.profileBlock}>
                <Avatar
                    avatarUrl={profile.avatarUrl}
                    displayName={profile.displayName}
                    seedId={profile.id}
                    size={AVATAR_SIZE}
                />
                <Text
                    style={[typography.heading, { color: palette.text }]}
                    numberOfLines={1}
                >
                    {profile.displayName}
                </Text>
                <Text style={[typography.caption, { color: palette.textMuted }]}>
                    @{profile.handle}
                </Text>
                <Text style={[typography.micro, { color: palette.textMuted }]}>
                    {formatFriendsSince(friendshipCreatedAt)}
                </Text>
                <Pressable
                    onPress={() =>
                        // Launches the title-picker with this friend marked
                        // as the recommendation target. After the user picks
                        // a title, library/add forwards to the recommend
                        // modal with preselect=<id> so it's pre-checked.
                        router.push({
                            pathname: '/library/add',
                            params: { recommendTo: profile.id },
                        })
                    }
                    style={({ pressed }) => [
                        styles.recommendButton,
                        { borderColor: palette.accent, opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <Send
                        color={palette.accent}
                        size={16}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.accent }]}
                    >
                        Recommend something
                    </Text>
                </Pressable>
                {/* Untied request: nudges this friend to send a rec.
                    Quieter than "Recommend something" (text-tinted, no
                    accent fill) since it's the lighter-weight ask. */}
                <Pressable
                    onPress={() =>
                        requestRec.open(profile.id, profile.displayName)
                    }
                    style={({ pressed }) => [
                        styles.requestButton,
                        { opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <MessageSquarePlus
                        color={palette.textMuted}
                        size={16}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textMuted },
                        ]}
                    >
                        Request a recommendation
                    </Text>
                </Pressable>
            </View>

            {/* Friend's top 5 sections — between the profile block and the
                library search/tabs. Conditional wrapper so the marginBottom
                doesn't fire when the friend has no favorites curated. */}
            {(favorites.movies.length > 0 || favorites.tv.length > 0) && (
                <View style={styles.topFiveBlock}>
                    <TopFiveSections
                        movies={favorites.movies}
                        tv={favorites.tv}
                        palette={palette}
                        onSelect={(mediaType, tmdbId) =>
                            router.push({
                                pathname: '/title/[mediaType]/[tmdbId]',
                                params: { mediaType, tmdbId: String(tmdbId) },
                            })
                        }
                    />
                </View>
            )}

            {/* Recs between you — the recommendation history both
                directions, most-recent first. Hidden entirely when there
                are none. Each card: poster + "From you" / "From {name}"
                (sender). Tapping opens the rec view (the conversation);
                for a rec you sent, that view shows the sender perspective.
                Full-bleed horizontal strip, matching Top 5 / where-to-watch. */}
            {recsBetween && recsBetween.length > 0 && (
                <View style={styles.recsBetweenSection}>
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            styles.recsBetweenHeading,
                            { color: palette.text },
                        ]}
                    >
                        Recs between you
                    </Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.recsBetweenScroll}
                        contentContainerStyle={styles.recsBetweenScrollContent}
                    >
                        {recsBetween.map((r) => (
                            <Pressable
                                key={r.recId}
                                onPress={() => router.push(`/rec/${r.recId}`)}
                                style={({ pressed }) => [
                                    styles.recBetweenCard,
                                    pressed && { opacity: 0.6 },
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={
                                    r.direction === 'sent'
                                        ? 'Recommendation you sent'
                                        : `Recommendation from ${profile.displayName}`
                                }
                            >
                                {r.posterPath ? (
                                    <Image
                                        source={{
                                            uri: imageUrl(r.posterPath, 'w185'),
                                        }}
                                        style={styles.recBetweenPoster}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                ) : (
                                    <View
                                        style={[
                                            styles.recBetweenPoster,
                                            { backgroundColor: palette.surfaceAlt },
                                        ]}
                                    />
                                )}
                                <Text
                                    style={[
                                        typography.micro,
                                        { color: palette.textMuted },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {r.direction === 'sent'
                                        ? 'From you'
                                        : `From ${profile.displayName.split(/\s+/)[0]}`}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}

            {/* Recent reviews — this friend's recently-WRITTEN reviews
                (newest review first, by reviews.updated_at). Each row:
                small poster + title + rating + the review text (snippet),
                or a "contains spoilers" placeholder for spoiler-flagged
                ones (the reveal flow lives on the title page). Tap → title.
                Hidden when they've written none. Capped to keep the header
                bounded. */}
            {recentReviews && recentReviews.length > 0 && (
                <View style={styles.recentReviewsSection}>
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.text },
                        ]}
                    >
                        Recent reviews
                    </Text>
                    {recentReviews.map((r) => {
                        const ratingText =
                            r.rating !== null ? formatRatingStars(r.rating) : '';
                        const snippet =
                            r.body.length > REVIEW_SNIPPET_CHARS
                                ? `${r.body.slice(0, REVIEW_SNIPPET_CHARS)}…`
                                : r.body;
                        return (
                            <Pressable
                                key={`${r.mediaType}:${r.tmdbId}`}
                                onPress={() =>
                                    router.push({
                                        pathname: '/title/[mediaType]/[tmdbId]',
                                        params: {
                                            mediaType: r.mediaType,
                                            tmdbId: String(r.tmdbId),
                                        },
                                    })
                                }
                                style={({ pressed }) => [
                                    styles.reviewRow,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                {r.posterPath ? (
                                    <Image
                                        source={{
                                            uri: imageUrl(r.posterPath, 'w185'),
                                        }}
                                        style={styles.reviewPoster}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                ) : (
                                    <View
                                        style={[
                                            styles.reviewPoster,
                                            {
                                                backgroundColor:
                                                    palette.surfaceAlt,
                                            },
                                        ]}
                                    />
                                )}
                                <View style={styles.reviewText}>
                                    <View style={styles.reviewTitleRow}>
                                        <Text
                                            style={[
                                                typography.bodyEmphasis,
                                                styles.reviewTitle,
                                                { color: palette.text },
                                            ]}
                                            numberOfLines={1}
                                        >
                                            {r.title}
                                        </Text>
                                        {ratingText !== '' && (
                                            <Text
                                                style={[
                                                    typography.caption,
                                                    { color: palette.textMuted },
                                                ]}
                                            >
                                                {ratingText}
                                            </Text>
                                        )}
                                    </View>
                                    {r.containsSpoilers ? (
                                        <Text
                                            style={[
                                                typography.caption,
                                                styles.reviewSpoiler,
                                                { color: palette.textMuted },
                                            ]}
                                        >
                                            Contains spoilers — tap to read
                                        </Text>
                                    ) : (
                                        <Text
                                            style={[
                                                typography.caption,
                                                { color: palette.textMuted },
                                            ]}
                                            numberOfLines={3}
                                        >
                                            {snippet}
                                        </Text>
                                    )}
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            )}

            {/* Hairline separating the overview/header sections (Top 5,
                recs, reviews) from the search + library-browse zone below.
                Full-bleed, low-contrast (palette.border) — same quiet
                divider idiom as the Library filter zone. */}
            <View
                style={[styles.headerDivider, { backgroundColor: palette.border }]}
            />

            {/* Local title search — mirrors the library tab's local-filter
                bar (X = clear-but-stay, Cancel = exit + dismiss). Wired to
                the shared hook's localQuery state. */}
            <View style={styles.searchRow}>
                <View
                    style={[styles.searchBar, { backgroundColor: palette.surface }]}
                >
                    <SearchIcon
                        color={palette.textMuted}
                        size={20}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <TextInput
                        ref={localSearchInputRef}
                        value={filters.localQuery}
                        onChangeText={filters.setLocalQuery}
                        placeholder={`Search ${profile.displayName}'s library`}
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                        onFocus={() => setLocalFocused(true)}
                        onBlur={() => setLocalFocused(false)}
                        style={[
                            styles.searchInput,
                            typography.body,
                            { color: palette.text },
                        ]}
                    />
                    {filters.localQuery.length > 0 ? (
                        <Pressable
                            onPress={() => filters.setLocalQuery('')}
                            hitSlop={spacing.sm}
                            accessibilityRole="button"
                            accessibilityLabel="Clear search"
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <X
                                color={palette.textMuted}
                                size={18}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    ) : null}
                </View>
                {localFocused ? (
                    <Pressable
                        onPress={() => {
                            filters.setLocalQuery('');
                            localSearchInputRef.current?.blur();
                        }}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel search"
                        style={({ pressed }) => [
                            styles.cancelButton,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Text style={[typography.body, { color: palette.accent }]}>
                            Cancel
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </>
    );

    // Sticky row (data[0]): segmented status picker + media/sort/genre
    // controls. Pins under the fixed headerBar once the profile info above
    // scrolls past. Page-bg fill (not the old surfaceAlt band): the
    // filters now sit on the page background like the Library screen, but
    // the fill stays OPAQUE so rows don't show through when it's stuck.
    const filterZoneNode = (
        <View style={[styles.filterZone, { backgroundColor: palette.bg }]}>
            <View style={styles.segmentedRow}>
                <SegmentedControl
                    options={TAB_OPTIONS}
                    value={activeTab}
                    onChange={setActiveTab}
                    palette={palette}
                />
            </View>
            <LibraryFilterControls
                palette={palette}
                mediaFilter={filters.mediaFilter}
                setMediaFilter={filters.setMediaFilter}
                sortBy={filters.sortBy}
                setSortBy={filters.setSortBy}
                availableSortOptions={filters.availableSortOptions}
                genreFilter={filters.genreFilter}
                setGenreFilter={filters.setGenreFilter}
                genreStripOpen={filters.genreStripOpen}
                setGenreStripOpen={filters.setGenreStripOpen}
                availableGenres={filters.availableGenres}
            />
        </View>
    );

    function renderListItem({ item }: { item: LibraryListItem }) {
        if (item.type === 'filters') return filterZoneNode;
        if (item.type === 'gridRow') {
            return (
                <View
                    style={[
                        styles.bodyInset,
                        styles.gridRow,
                        { columnGap: GRID_GAP_BY_COLS[gridCols] },
                    ]}
                >
                    {item.rows.map((row) => (
                        <View key={row.id}>{renderGridCell({ item: row })}</View>
                    ))}
                </View>
            );
        }
        return (
            <View style={styles.bodyInset}>{renderRow({ item: item.row })}</View>
        );
    }

    // Loading / error / empty live below the sticky filter row so the tabs
    // stay reachable in every state. Order matters: error first, then the
    // spinner ONLY on a first load with no rows yet (a tab-switch reload
    // keeps the previous rows mounted and shows no spinner, so scroll is
    // preserved — see showBody above), then the empty copy once a load has
    // completed with nothing. Empty copy has three sub-cases, in priority
    // order: typed-search → genre filter → per-tab default.
    const listFooter = itemsError ? (
        <View style={styles.footerStatus}>
            <Text
                style={[
                    typography.body,
                    styles.centerText,
                    { color: palette.error },
                ]}
                numberOfLines={3}
            >
                {itemsError}
            </Text>
        </View>
    ) : itemsLoading && !hasRows ? (
        <View style={styles.footerStatus}>
            <ActivityIndicator color={palette.accent} />
        </View>
    ) : !itemsLoading && !hasRows ? (
        <View style={styles.footerStatus}>
            <Text
                style={[
                    typography.body,
                    styles.centerText,
                    { color: palette.textMuted },
                ]}
            >
                {filters.localQuery.trim().length > 0
                    ? `No matches in @${profile.handle}'s library.`
                    : filters.genreFilter !== null
                      ? `No ${TMDB_GENRE_NAMES.get(filters.genreFilter) ?? 'matching'} titles.`
                      : emptyMessage(activeTab, profile.displayName)}
            </Text>
        </View>
    ) : null;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <SafeAreaView edges={['top']} style={{ backgroundColor: palette.bg }}>
                <View style={styles.headerBar}>
                    {backButton}
                    <View style={styles.headerBarRight}>
                        <ViewControls
                            mode={mode}
                            gridCols={gridCols}
                            onModeChange={setMode}
                            onGridColsChange={setGridCols}
                            palette={palette}
                        />
                        <Pressable
                            onPress={openFriendMenu}
                            disabled={removing}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel="More options"
                            style={({ pressed }) => [
                                styles.overflowButton,
                                (pressed || removing) && { opacity: 0.5 },
                            ]}
                        >
                            <MoreVertical
                                size={22}
                                color={palette.text}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    </View>
                </View>
            </SafeAreaView>

            <FlatList
                data={listData}
                keyExtractor={(item) =>
                    item.type === 'filters'
                        ? 'filters'
                        : item.type === 'listRow'
                          ? item.row.id
                          : `gridrow-${item.rows.map((r) => r.id).join('-')}`
                }
                renderItem={renderListItem}
                ListHeaderComponent={listHeader}
                // ListHeaderComponent is child 0; the sticky 'filters' item
                // (data[0]) is child 1.
                stickyHeaderIndices={[1]}
                ListFooterComponent={listFooter}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                ItemSeparatorComponent={({
                    leadingItem,
                }: {
                    leadingItem: LibraryListItem;
                }) => {
                    if (leadingItem.type === 'listRow') {
                        return (
                            <View style={styles.bodyInset}>
                                <View
                                    style={[
                                        styles.separator,
                                        { backgroundColor: palette.border },
                                    ]}
                                />
                            </View>
                        );
                    }
                    if (leadingItem.type === 'gridRow') {
                        return (
                            <View style={{ height: GRID_GAP_BY_COLS[gridCols] }} />
                        );
                    }
                    // After the sticky filters row: grid gets a small top gap
                    // (matched old gridContent paddingTop); list sat flush.
                    return mode === 'grid' ? (
                        <View style={{ height: spacing.sm }} />
                    ) : null;
                }}
            />

            <RequestRecSheet
                visible={requestRec.target !== null}
                friendName={requestRec.target?.name ?? ''}
                busy={requestRec.busy}
                onCancel={requestRec.close}
                onSend={requestRec.send}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    headerBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
    headerBarRight: {
        // Push the view-controls cluster (+ overflow menu) to the right
        // edge of the header bar. The back button sits at the left; this
        // slot is its mirror.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        marginLeft: 'auto',
    },
    overflowButton: {
        padding: spacing.xs,
    },
    profileBlock: {
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
        gap: spacing.xs,
    },
    topFiveBlock: {
        // Vertical breathing room below the top-5 sections; zero-
        // height when both arrays are empty (the component returns
        // null), so no stray padding appears in the no-favorites case.
        marginBottom: spacing.md,
    },
    recsBetweenSection: {
        // Heading + strip block, base inset, spaced below Top 5 and above
        // the search row. Inner gap separates heading from the strip.
        paddingHorizontal: spacing.base,
        marginBottom: spacing.md,
        gap: spacing.sm,
    },
    recsBetweenHeading: {
        // No horizontal inset of its own — the section provides it.
    },
    recsBetweenScroll: {
        // Full-bleed so cards scroll edge-to-edge with the next peeking,
        // matching the where-to-watch / cast rows.
        marginHorizontal: -REC_STRIP_INSET,
    },
    recsBetweenScrollContent: {
        // Inset + gap must match REC_BETWEEN_POSTER_W's peek math above.
        paddingHorizontal: REC_STRIP_INSET,
        gap: REC_STRIP_GAP,
    },
    recBetweenCard: {
        width: REC_BETWEEN_POSTER_W,
        gap: spacing.xs,
    },
    recBetweenPoster: {
        width: REC_BETWEEN_POSTER_W,
        height: REC_BETWEEN_POSTER_H,
        borderRadius: radius.sm,
    },
    recentReviewsSection: {
        // Heading + capped vertical list, base inset. marginTop adds
        // separation from the recs strip above; marginBottom spaces it
        // from the divider/search below. Inner gap separates the heading
        // and the rows.
        paddingHorizontal: spacing.base,
        marginTop: spacing.md,
        marginBottom: spacing.md,
        gap: spacing.sm,
    },
    reviewRow: {
        flexDirection: 'row',
        gap: spacing.md,
        alignItems: 'flex-start',
    },
    reviewPoster: {
        width: REVIEW_POSTER_W,
        height: REVIEW_POSTER_H,
        borderRadius: radius.sm,
    },
    reviewText: {
        flex: 1,
        gap: spacing.xs,
    },
    reviewTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
    },
    reviewTitle: {
        // Flex so the title truncates instead of pushing the rating off.
        flex: 1,
    },
    reviewSpoiler: {
        fontStyle: 'italic',
    },
    headerDivider: {
        // Full-bleed hairline between the overview sections and the search
        // + browse zone. Colour applied inline (palette.border). The space
        // above comes from the preceding section's marginBottom; the space
        // below comes from searchRow's marginTop.
        height: StyleSheet.hairlineWidth,
    },
    searchRow: {
        // Outer row hosting the search pill + the conditional Cancel
        // sibling. Margins live here (not on the pill) so the pill
        // can flex to fill available width when Cancel appears /
        // disappears. Mirrors Home's SearchBarInput row layout. Generous
        // top/bottom margin gives the bar breathing room between the
        // hairline above and the filter zone below (it read as cramped).
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.lg,
        marginBottom: spacing.lg,
    },
    searchBar: {
        // Local title-filter input. Mirrors the own library's
        // .localSearchBar pill shape so the two screens read the
        // same, minus the `+` button (friend libraries have no add
        // affordance). Border deliberately omitted — the surface
        // fill against the page bg is the visual separation;
        // pairing fill + border reads as a generic input pill.
        // flex: 1 so the pill shrinks when Cancel appears in the
        // outer row.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    cancelButton: {
        // Plain text Pressable, sized via horizontal padding.
        // Mirrors Home SearchBarInput's cancel button styling.
        paddingHorizontal: spacing.xs,
    },
    searchInput: {
        flex: 1,
        // padding zeroed: the parent's fixed height owns vertical
        // sizing so the icon and text stay aligned.
        paddingVertical: 0,
    },
    notFriendsBlock: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        alignItems: 'center',
        gap: spacing.lg,
    },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        gap: spacing.sm,
    },
    centerText: {
        textAlign: 'center',
    },
    primaryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.full,
    },
    recommendButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
        borderRadius: radius.full,
        borderWidth: 1.5,
        marginTop: spacing.md,
    },
    requestButton: {
        // Borderless sibling under the recommend button — the lighter
        // "ask" action sits quieter than the bordered "send" action.
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
        marginTop: spacing.xs,
    },
    filterZone: {
        // No shaded band — the controls sit on the page background (fill
        // applied inline as palette.bg, kept opaque so rows don't show
        // through when this sticky zone is stuck). Matches the Library
        // screen's filter zone. The overview/browse separation is the
        // hairline above the search bar (headerDivider).
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.md,
    },
    segmentedRow: {
        // Horizontal inset for the segmented control matching the
        // rest of the screen's content gutters.
        paddingHorizontal: spacing.base,
    },
    scrollContent: {
        // Whole-screen FlatList: only a bottom cushion is needed here.
        // Horizontal insets live on the header/filter/body items, which
        // each manage their own gutters.
        paddingBottom: spacing.lg,
    },
    bodyInset: {
        // Horizontal gutter for library rows / grid rows + their
        // separators — replaces the old listContent/gridContent
        // paddingHorizontal now that they're items in one FlatList.
        paddingHorizontal: spacing.base,
    },
    gridRow: {
        // One chunked row of grid cells. flex-start so a short last row
        // stays left-aligned (matches the old columnWrapper behaviour).
        flexDirection: 'row',
    },
    footerStatus: {
        // Loading / error / empty message, shown under the sticky filter
        // row. Top padding gives it air instead of jamming under the tabs.
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: spacing.xxl,
        paddingHorizontal: spacing.xl,
        gap: spacing.sm,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    poster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: POSTER_W + spacing.md,
    },
    // Grid cell styles mirror the Library tab so a friend's grid looks
    // identical at the same density. Values pulled across verbatim;
    // diverging here would create a subtle inconsistency between
    // "my library" and "their library" at a glance.
    gridCell: {
        position: 'relative',
    },
    gridPoster: {
        borderRadius: radius.sm,
    },
    gridRatingChip: {
        position: 'absolute',
        bottom: spacing.xs,
        left: spacing.xs,
        paddingHorizontal: spacing.xs,
        paddingVertical: 3,
        borderRadius: radius.sm,
        opacity: 0.92,
    },
    gridRatingText: {
        ...typography.caption,
        fontWeight: '600',
    },
});
