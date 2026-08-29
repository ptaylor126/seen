import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
    MagnifyingGlass,
    X,
} from 'phosphor-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    FlatList,
    Pressable,
    SectionList,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { LoadError } from '@/components/load-error';
import { Text } from '@/components/text';
import { TextInput } from '@/components/text-input';
import supabase from '@/lib/supabase';
import {
    getPopular,
    getTrending,
    imageUrl,
    searchMulti,
    type TMDBMediaItem,
    type TMDBPersonSummary,
} from '@/lib/tmdb';
import {
    posterFrame,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// TMDB returns plenty of rows without posters / profile images and a
// mix of media types — filter at the type level so consumers don't have
// to. People are included now (the "search by person" feature) but kept
// as a separate variant of the union so renderers + tap-handlers branch
// cleanly on media_type.
export type SearchableTitle =
    | (TMDBMediaItem & { media_type: 'movie'; poster_path: string })
    | (TMDBMediaItem & { media_type: 'tv'; poster_path: string });

export type SearchablePerson = TMDBPersonSummary & {
    media_type: 'person';
    profile_path: string; // narrowed from `string | null` after filter
};

export type SearchableItem = SearchableTitle | SearchablePerson;

// A friend of the signed-in user, for the FRIENDS section of the home
// overlay. Loaded lazily once per session (see ensureFriendsLoaded) and
// filtered locally per keystroke — a dozen-item list, no server
// round-trip per query.
export interface FriendHit {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

// Overlay rows are TMDB results or friend rows; `kind` discriminates
// the friend branch (TMDB rows carry media_type instead).
type OverlayItem = SearchableItem | (FriendHit & { kind: 'friend' });

const FRIEND_RESULTS_CAP = 5;

// Prefix-first fuzzy-ish friend filter: handle-prefix or name-word-prefix
// matches rank first, plain substring matches after. A dozen-item local
// filter, deliberately not a search engine.
function matchFriends(list: FriendHit[], rawQuery: string): FriendHit[] {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return [];
    const prefix: FriendHit[] = [];
    const substring: FriendHit[] = [];
    for (const f of list) {
        const handle = f.handle.toLowerCase();
        const name = f.displayName.toLowerCase();
        if (handle.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) {
            prefix.push(f);
        } else if (handle.includes(q) || name.includes(q)) {
            substring.push(f);
        }
    }
    return [...prefix, ...substring].slice(0, FRIEND_RESULTS_CAP);
}

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_POSTER_W = 56;
const SEARCH_RESULT_POSTER_H = 84;
// Profile images render as circles, sized to match the title-row
// poster height for a consistent visual rhythm across the blended
// results section.
const SEARCH_RESULT_PROFILE_SIZE = 56;
// Cap the People section in the overlay so a query like "john" with
// 20 matching people doesn't drown the title results. Five disambiguates
// well in practice; a user wanting a specific actor narrows by typing
// more.
const PEOPLE_RESULTS_CAP = 5;

// Home-only "discover" grid shown in the overlay's empty state before the user
// types: straight trending + popular (NOT the onboarding blend), with a light
// content filter so obscure / suggestive titles don't surface.
const DISCOVER_VOTE_FLOOR = 150; // drop the low-vote obscure long-tail
const DISCOVER_COLUMNS = 3;
const DISCOVER_TILE_CAP = 21; // 3 columns × up to 7 rows

export interface DiscoverTile {
    id: number;
    media_type: 'movie' | 'tv';
    poster_path: string;
}

// Vertical distance from the safe-area top inset to the bottom of the
// search bar. Same on Home and Library because both screens use the
// same header geometry (paddingVertical: spacing.md × 2 = 24 + display
// lineHeight 38 + searchBar marginTop spacing.sm 8 + searchBar height
// 44 = 114; rounded up to 116 for a hairline of breathing room before
// the overlay). Screens compute `insets.top + SEARCH_OVERLAY_TOP_OFFSET`
// and pass it as the overlay's `top` prop.
export const SEARCH_OVERLAY_TOP_OFFSET = 116;

export interface SearchBarState {
    query: string;
    setQuery: (q: string) => void;
    results: SearchableItem[] | null;
    loading: boolean;
    error: string | null;
    overlayVisible: boolean;
    inputRef: React.RefObject<TextInput | null>;
    handleFocus: () => void;
    dismiss: () => void;
    handleResultTap: (item: SearchableItem) => void;
    // Opens a title's detail screen — the shared "add path" used by both a
    // tapped search result and a tapped discover tile.
    openTitle: (media: 'movie' | 'tv', id: number) => void;
    // Home-only discover grid (trending/popular) for the pre-typing empty
    // state. Loaded lazily via ensureDiscoverLoaded.
    discoverItems: DiscoverTile[] | null;
    discoverLoading: boolean;
    ensureDiscoverLoaded: () => void;
    // Re-runs the current query's search (used by the friendly error retry).
    retry: () => void;
    // Friends of the signed-in user for the home overlay's FRIENDS
    // section. Lazily loaded once per session via ensureFriendsLoaded.
    friends: FriendHit[] | null;
    ensureFriendsLoaded: () => void;
    // Opens a friend's profile (dismisses the overlay first) — the
    // friend-row sibling of openTitle.
    openFriend: (handle: string) => void;
}

// Owns every piece of search state + the debounced TMDB query + the
// result-tap navigation. Screens call this once and pass the returned
// state to <SearchBarInput> and <SearchBarOverlay>.
export function useSearchBar(): SearchBarState {
    const router = useRouter();
    const inputRef = useRef<TextInput | null>(null);
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [results, setResults] = useState<SearchableItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped by the friendly error's "Try again" to re-run the current
    // query's search (a dependency of the debounced search effect below).
    const [reloadKey, setReloadKey] = useState(0);

    // Home-only discover tiles for the pre-typing empty state. Loaded lazily
    // on first focus via ensureDiscoverLoaded and cached for the hook's
    // lifetime; discoverStartedRef guards against a refetch on re-open.
    const [discoverItems, setDiscoverItems] = useState<DiscoverTile[] | null>(
        null,
    );
    const [discoverLoading, setDiscoverLoading] = useState(false);
    const discoverStartedRef = useRef(false);

    // Friends cache — same lazy run-once shape as discover. There is no
    // app-wide friends provider (home fetches friendship IDS inside its
    // own HomeData load; the Friends tab fetches its own list), so the
    // overlay owns one small fetch: friendships → profiles, then every
    // keystroke filters in memory.
    const [friends, setFriends] = useState<FriendHit[] | null>(null);
    const friendsStartedRef = useRef(false);

    // 300ms debounce + stale-result guard. Cancellation runs on every
    // query change AND on unmount.
    useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed) {
            setResults(null);
            setError(null);
            setLoading(false);
            return;
        }

        let active = true;
        setLoading(true);

        const handle = setTimeout(async () => {
            try {
                const response = await searchMulti(trimmed, 1);
                if (!active) return;
                // Keep titles with posters AND people with profile
                // images. Same "no image, skip it" filter applies to
                // both — drops the visually broken rows and the data-
                // poor TMDB entries in one rule.
                const filtered = response.results.filter(
                    (item): item is SearchableItem => {
                        if (
                            item.media_type === 'movie' ||
                            item.media_type === 'tv'
                        ) {
                            return !!item.poster_path;
                        }
                        if (item.media_type === 'person') {
                            return !!item.profile_path;
                        }
                        return false;
                    },
                );
                setResults(filtered);
                setError(null);
            } catch (err) {
                if (!active) return;
                setResults([]);
                setError(err instanceof Error ? err.message : 'Search failed');
            } finally {
                if (active) setLoading(false);
            }
        }, SEARCH_DEBOUNCE_MS);

        return () => {
            active = false;
            clearTimeout(handle);
        };
    }, [query, reloadKey]);

    const ensureFriendsLoaded = useCallback(() => {
        if (friendsStartedRef.current) return;
        friendsStartedRef.current = true;
        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const userId = session?.user.id;
                if (!userId) return;
                const friendshipsRes = await supabase
                    .from('friendships')
                    .select('user_a_id, user_b_id')
                    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`);
                if (friendshipsRes.error) throw friendshipsRes.error;
                const friendIds = (friendshipsRes.data ?? []).map((f) =>
                    f.user_a_id === userId ? f.user_b_id : f.user_a_id,
                );
                if (friendIds.length === 0) {
                    setFriends([]);
                    return;
                }
                const profilesRes = await supabase
                    .from('profiles')
                    .select('id, handle, display_name, avatar_url')
                    .in('id', friendIds);
                if (profilesRes.error) throw profilesRes.error;
                setFriends(
                    (profilesRes.data ?? []).map((row) => ({
                        userId: row.id,
                        handle: row.handle,
                        displayName: row.display_name,
                        avatarUrl: row.avatar_url,
                    })),
                );
            } catch (err) {
                // Best-effort section: a failed load just means no
                // FRIENDS section this session, never a broken search.
                console.warn('friend search load failed:', err);
            }
        })();
    }, []);

    const handleFocus = useCallback(() => {
        setOpen(true);
    }, []);

    const dismiss = useCallback(() => {
        setQuery('');
        setResults(null);
        setError(null);
        setOpen(false);
        inputRef.current?.blur();
    }, []);

    // The single "open a title" navigation — the add path. Both a tapped
    // search result and a tapped discover tile route through this, so
    // tap-to-add is identical on both.
    const openTitle = useCallback(
        (media: 'movie' | 'tv', id: number) => {
            dismiss();
            router.push({
                pathname: '/title/[mediaType]/[tmdbId]',
                params: { mediaType: media, tmdbId: String(id) },
            });
        },
        [router, dismiss],
    );

    const openFriend = useCallback(
        (handle: string) => {
            dismiss();
            router.push({
                pathname: '/friends/[handle]',
                params: { handle },
            });
        },
        [router, dismiss],
    );

    const handleResultTap = useCallback(
        (item: SearchableItem) => {
            if (item.media_type === 'person') {
                dismiss();
                router.push({
                    pathname: '/person/[personId]',
                    params: { personId: String(item.id) },
                });
                return;
            }
            openTitle(item.media_type, item.id);
        },
        [router, dismiss, openTitle],
    );

    // Lazily fetch straight trending + popular (movie + tv, page 1) for the
    // Home discover grid — NOT the onboarding blend. Keeps a light content
    // filter (poster required, adult excluded, vote-count floor) so obscure /
    // suggestive titles don't surface. Best-effort: on any failure the grid
    // just stays empty and the overlay falls back to blank. Runs once per
    // hook lifetime.
    const ensureDiscoverLoaded = useCallback(async () => {
        if (discoverStartedRef.current) return;
        discoverStartedRef.current = true;
        setDiscoverLoading(true);
        try {
            const calls = [
                { media: 'movie' as const, req: getTrending('movie', 1) },
                { media: 'tv' as const, req: getTrending('tv', 1) },
                { media: 'movie' as const, req: getPopular('movie', 1) },
                { media: 'tv' as const, req: getPopular('tv', 1) },
            ];
            const settled = await Promise.allSettled(calls.map((c) => c.req));
            const seen = new Set<string>();
            const byMedia: Record<'movie' | 'tv', DiscoverTile[]> = {
                movie: [],
                tv: [],
            };
            settled.forEach((res, i) => {
                if (res.status !== 'fulfilled') return;
                const media = calls[i].media;
                for (const item of res.value.results) {
                    if (!item.poster_path) continue; // must have a poster
                    if (item.adult === true) continue; // adult exclusion
                    if ((item.vote_count ?? 0) < DISCOVER_VOTE_FLOOR) continue;
                    const key = `${media}:${item.id}`;
                    if (seen.has(key)) continue; // de-dupe across sources
                    seen.add(key);
                    byMedia[media].push({
                        id: item.id,
                        media_type: media,
                        poster_path: item.poster_path,
                    });
                }
            });
            // Interleave movie/tv for a varied grid, cap, then trim to whole
            // rows so the last row isn't a stretched partial.
            const interleaved: DiscoverTile[] = [];
            const max = Math.max(byMedia.movie.length, byMedia.tv.length);
            for (
                let i = 0;
                i < max && interleaved.length < DISCOVER_TILE_CAP;
                i++
            ) {
                if (byMedia.movie[i]) interleaved.push(byMedia.movie[i]);
                if (byMedia.tv[i] && interleaved.length < DISCOVER_TILE_CAP) {
                    interleaved.push(byMedia.tv[i]);
                }
            }
            const fullRows =
                interleaved.length - (interleaved.length % DISCOVER_COLUMNS);
            setDiscoverItems(interleaved.slice(0, fullRows));
        } catch {
            setDiscoverItems([]);
        } finally {
            setDiscoverLoading(false);
        }
    }, []);

    return {
        query,
        setQuery,
        results,
        friends,
        ensureFriendsLoaded,
        openFriend,
        loading,
        error,
        overlayVisible: open || query.length > 0,
        inputRef,
        handleFocus,
        dismiss,
        handleResultTap,
        openTitle,
        discoverItems,
        discoverLoading,
        ensureDiscoverLoaded,
        retry: () => setReloadKey((k) => k + 1),
    };
}

export function SearchBarInput({ state }: { state: SearchBarState }) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    return (
        <View style={styles.row}>
            <View
                style={[
                    styles.bar,
                    {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                    },
                ]}
            >
                <MagnifyingGlass
                    color={palette.textMuted}
                    size={20}
                />
                <TextInput
                    ref={state.inputRef}
                    value={state.query}
                    onChangeText={state.setQuery}
                    onFocus={state.handleFocus}
                    // DELIBERATE copy change (friends-in-search v1) — this exact
                    // string was previously mangled by the icon-rename slip;
                    // this time the new wording is intentional.
                    placeholder="Find films, shows and friends"
                    placeholderTextColor={palette.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    style={[styles.input, typography.body, { color: palette.text }]}
                />
                {/* Inline clear-X: shows when the field has text. Tap
                    clears the query but keeps focus + the overlay open
                    so the user can re-type without exiting search. The
                    sibling Cancel button (rendered when overlayVisible)
                    is what fully exits — X is the "clear and keep
                    typing" sub-action. */}
                {state.query.length > 0 ? (
                    <Pressable
                        onPress={() => state.setQuery('')}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <X
                            color={palette.textMuted}
                            size={18}
                        />
                    </Pressable>
                ) : null}
            </View>
            {state.overlayVisible ? (
                <Pressable
                    onPress={state.dismiss}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel search"
                    style={({ pressed }) => [
                        styles.cancelButton,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <Text
                        style={[typography.body, { color: palette.accent }]}
                    >
                        Cancel
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

// TMDB's known_for_department uses verb-form ("Acting", "Directing",
// "Writing") which reads awkwardly as a row label. Map to friendly
// nouns. Anything we don't have a mapping for falls through unchanged
// — TMDB only really uses ~6 values here.
function friendlyDepartment(value: string | undefined): string {
    if (!value) return '';
    switch (value) {
        case 'Acting':
            return 'Actor';
        case 'Directing':
            return 'Director';
        case 'Writing':
            return 'Writer';
        case 'Production':
            return 'Producer';
        default:
            return value;
    }
}

export function SearchBarOverlay({
    state,
    top,
    showDiscover = false,
    showFriends = false,
}: {
    state: SearchBarState;
    top: number;
    // Home-only: render the trending/popular discover grid in the pre-typing
    // empty state (and kick off its lazy fetch). Off on Library, whose search
    // filters the user's own library — trending titles they may not own would
    // be confusing there.
    showDiscover?: boolean;
    // Home-only: blend the user's FRIENDS into results (and kick off the
    // lazy friends fetch). Off on Library, whose overlay is the add-a-
    // title flow — a friend row would be a non-sequitur there.
    showFriends?: boolean;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    // The overlay is absolute-positioned to the screen bottom (under the
    // floating nav), so the results list needs the same bottom inset the
    // other tab lists use — nav height + bottom gap + safe-area inset —
    // plus a small margin so the last row clears the nav pill and stays
    // tappable. Reuses the shared hook so it tracks nav-height changes.
    const tabBarInset = useFloatingTabBarInset();
    // App-standard eyes loader, gated so quick searches don't flash it.
    const busy = useDeferredLoading(state.loading);

    // Kick off the Home discover fetch once when discovery is enabled.
    // ensureDiscoverLoaded is a stable, run-once callback, so the overlay
    // re-mounting on each search-open doesn't refetch.
    const { ensureDiscoverLoaded, ensureFriendsLoaded } = state;
    useEffect(() => {
        if (showDiscover) ensureDiscoverLoaded();
    }, [showDiscover, ensureDiscoverLoaded]);
    useEffect(() => {
        if (showFriends) ensureFriendsLoaded();
    }, [showFriends, ensureFriendsLoaded]);

    function renderDiscover() {
        const tiles = state.discoverItems;
        // Still loading, or the fetch failed → keep it blank. This is a
        // best-effort surface shown before the user has even typed; never an
        // error state.
        if (!tiles || tiles.length === 0) {
            return <View style={styles.statusBlock} />;
        }
        return (
            <FlatList
                data={tiles}
                keyExtractor={(t) => `${t.media_type}-${t.id}`}
                numColumns={DISCOVER_COLUMNS}
                renderItem={({ item }) => (
                    <Pressable
                        onPress={() => state.openTitle(item.media_type, item.id)}
                        style={({ pressed }) => [
                            styles.discoverTile,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Image
                            source={{ uri: imageUrl(item.poster_path, 'w342') }}
                            style={styles.discoverPoster}
                            contentFit="cover"
                            transition={150}
                        />
                    </Pressable>
                )}
                ListHeaderComponent={
                    <Text
                        style={[
                            typography.micro,
                            styles.discoverHeading,
                            { color: palette.textMuted },
                        ]}
                    >
                        POPULAR RIGHT NOW
                    </Text>
                }
                columnWrapperStyle={styles.discoverRow}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={[
                    styles.discoverContent,
                    { paddingBottom: tabBarInset + spacing.lg },
                ]}
            />
        );
    }

    function renderTitleRow(item: SearchableTitle) {
        const titleText = item.media_type === 'movie' ? item.title : item.name;
        const dateField =
            item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = dateField ? dateField.slice(0, 4) : '';
        const mediaLabel = item.media_type === 'movie' ? 'Movie' : 'TV Show';
        const metaLine = [year, mediaLabel].filter(Boolean).join(' · ');
        return (
            <Pressable
                onPress={() => state.handleResultTap(item)}
                style={({ pressed }) => [
                    styles.resultRow,
                    pressed && { opacity: 0.6 },
                ]}
            >
                <Image
                    source={{ uri: imageUrl(item.poster_path, 'w185') }}
                    style={styles.resultPoster}
                    contentFit="cover"
                    transition={150}
                />
                <View style={styles.resultText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {titleText}
                    </Text>
                    {metaLine ? (
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            {metaLine}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    function renderPersonRow(item: SearchablePerson) {
        const department = friendlyDepartment(item.known_for_department);
        return (
            <Pressable
                onPress={() => state.handleResultTap(item)}
                style={({ pressed }) => [
                    styles.resultRow,
                    pressed && { opacity: 0.6 },
                ]}
            >
                <Image
                    source={{ uri: imageUrl(item.profile_path, 'w185') }}
                    style={styles.resultProfile}
                    contentFit="cover"
                    transition={150}
                />
                <View style={styles.resultText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={2}
                    >
                        {item.name}
                    </Text>
                    {department ? (
                        <Text
                            style={[typography.caption, { color: palette.textMuted }]}
                        >
                            {department}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        );
    }

    function renderFriendRow(item: FriendHit) {
        return (
            <Pressable
                onPress={() => state.openFriend(item.handle)}
                style={({ pressed }) => [
                    styles.resultRow,
                    pressed && { opacity: 0.6 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${item.displayName}, @${item.handle}`}
            >
                {/* Avatar + name + @handle — the friends-list row grammar. */}
                <Avatar
                    avatarUrl={item.avatarUrl}
                    displayName={item.displayName}
                    seedId={item.userId}
                    size={SEARCH_RESULT_PROFILE_SIZE}
                />
                <View style={styles.resultText}>
                    <Text
                        style={[typography.body, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {item.displayName}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                        numberOfLines={1}
                    >
                        @{item.handle}
                    </Text>
                </View>
            </Pressable>
        );
    }

    // Partition the blended results into a People section (capped) and
    // a Titles section. People appear first because a query that names
    // a person is much more likely to be searching for them than for a
    // title containing their name. Empty sections are dropped so the
    // user doesn't see a "PEOPLE" header with nothing under it on a
    // pure-title query.
    const peopleResults = (state.results ?? [])
        .filter((r): r is SearchablePerson => r.media_type === 'person')
        .slice(0, PEOPLE_RESULTS_CAP);
    const titleResults = (state.results ?? []).filter(
        (r): r is SearchableTitle => r.media_type !== 'person',
    );
    // FRIENDS leads: a query matching someone you know is even more
    // likely aimed at them than at a TMDB person (the same logic that
    // put PEOPLE above TITLES, one rung more personal).
    const friendMatches: OverlayItem[] =
        showFriends && state.friends
            ? matchFriends(state.friends, state.query).map((f) => ({
                  ...f,
                  kind: 'friend' as const,
              }))
            : [];
    const sections: { title: string; data: OverlayItem[] }[] = [];
    if (friendMatches.length > 0) {
        sections.push({ title: 'FRIENDS', data: friendMatches });
    }
    if (peopleResults.length > 0) {
        sections.push({ title: 'PEOPLE', data: peopleResults });
    }
    if (titleResults.length > 0) {
        sections.push({ title: 'TITLES', data: titleResults });
    }

    return (
        <View
            style={[
                styles.overlay,
                {
                    top,
                    backgroundColor: palette.bg,
                },
            ]}
        >
            {busy ? (
                // App-standard eyes loader, top-anchored under the search bar.
                <FullScreenLoader style={styles.statusTop} />
            ) : state.results === null ? (
                // Before the user types: the Home discover grid, or a blank
                // space-reserving box elsewhere (the input placeholder already
                // states the action).
                showDiscover ? (
                    renderDiscover()
                ) : (
                    <View style={styles.statusBlock} />
                )
            ) : state.error ? (
                // Friendly fallback — never show the raw proxy/TMDB error.
                // Retry re-runs the current query's search.
                <LoadError
                    compact
                    title="Couldn't reach search"
                    message="Check your connection and try again."
                    onRetry={state.retry}
                />
            ) : state.results.length === 0 && friendMatches.length === 0 ? (
                <View style={styles.statusBlock}>
                    <Text
                        style={[typography.body, { color: palette.textMuted }]}
                        numberOfLines={2}
                    >
                        {`No results for "${state.query.trim()}"`}
                    </Text>
                </View>
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={(item) =>
                        'kind' in item
                            ? `friend-${item.userId}`
                            : `${item.media_type}-${item.id}`
                    }
                    renderItem={({ item }) =>
                        'kind' in item
                            ? renderFriendRow(item)
                            : item.media_type === 'person'
                              ? renderPersonRow(item)
                              : renderTitleRow(item)
                    }
                    renderSectionHeader={({ section }) => (
                        <View
                            style={[
                                styles.sectionHeader,
                                { backgroundColor: palette.bg },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionHeaderText,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {section.title}
                            </Text>
                        </View>
                    )}
                    // Sticky headers would look fine but the section
                    // count is small (max 2) and the header
                    // breathing room reads cleaner without them.
                    stickySectionHeadersEnabled={false}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    contentContainerStyle={[
                        styles.listContent,
                        { paddingBottom: tabBarInset + spacing.lg },
                    ]}
                    ItemSeparatorComponent={() => (
                        <View
                            style={[
                                styles.separator,
                                { backgroundColor: palette.border },
                            ]}
                        />
                    )}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        // Outer row wraps the bar + the conditional Cancel button. The
        // bar gets `flex: 1` so it expands when Cancel is absent and
        // shrinks to accommodate Cancel when it appears, the standard
        // iOS Mail / Notes search-bar shape.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
    },
    bar: {
        // Borderless — the surface fill against the page bg is the
        // visual separation (matches the borderless local search bars
        // on Library + friend's-library). Pairing fill + border reads
        // as a generic input pill; dropping the border lets the
        // accent + pill shape do the work.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    cancelButton: {
        // Visible only while the overlay is open. Plain text Pressable
        // — matches iOS standard search Cancel.
        paddingHorizontal: spacing.xs,
    },
    input: {
        flex: 1,
        // padding zeroed: the parent .bar height owns vertical sizing so
        // the icon and text stay perfectly aligned.
        paddingVertical: 0,
    },
    overlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        // Above body content so taps inside results land on results,
        // not on whatever's behind. The host screen's header + search
        // bar sit above this top edge in normal flow, so the input
        // stays tappable while the overlay is open.
        zIndex: 10,
    },
    statusBlock: {
        // Top-anchored (not vertically centred) so "No results" and the
        // loader sit directly under the search bar where results appear —
        // centring pushed them into the tall overlay's middle, behind the
        // keyboard.
        flex: 1,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: spacing.xl,
        paddingHorizontal: spacing.xl,
    },
    // FullScreenLoader defaults to centring; this override top-anchors the
    // eyes under the search bar to match statusBlock.
    statusTop: {
        justifyContent: 'flex-start',
        paddingTop: spacing.xl,
    },
    discoverContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
    },
    discoverHeading: {
        letterSpacing: 1.2,
        paddingHorizontal: spacing.xs,
        paddingBottom: spacing.sm,
    },
    discoverRow: {
        gap: spacing.sm,
    },
    discoverTile: {
        flex: 1,
        marginBottom: spacing.sm,
    },
    discoverPoster: {
        ...posterFrame,
        width: '100%',
        aspectRatio: 2 / 3,
        borderRadius: radius.sm,
    },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.xl,
        paddingBottom: spacing.lg,
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    resultPoster: {
        ...posterFrame,
        width: SEARCH_RESULT_POSTER_W,
        height: SEARCH_RESULT_POSTER_H,
        borderRadius: radius.sm,
    },
    resultProfile: {
        width: SEARCH_RESULT_PROFILE_SIZE,
        height: SEARCH_RESULT_PROFILE_SIZE,
        borderRadius: SEARCH_RESULT_PROFILE_SIZE / 2,
    },
    resultText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: SEARCH_RESULT_POSTER_W + spacing.md,
    },
    sectionHeader: {
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
    },
    sectionHeaderText: {
        letterSpacing: 1.2,
    },
});
