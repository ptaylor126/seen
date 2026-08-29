import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
    CaretLeft,
    ChatText,
    DotsThree,
    DotsThreeVertical,
    PaperPlaneTilt,
    UserPlus,
} from 'phosphor-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Pressable,
    ScrollView,
    StatusBar,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import Animated, {
    useAnimatedRef,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { ArchCap, ARCH_DEPTH } from '@/components/profile-arch';
import { ChatsBetweenSection } from '@/components/chats-between-section';
import { FriendLibrary } from '@/components/friend-library';
import { Text } from '@/components/text';
import { TopFiveSections } from '@/components/top-five-sections';
import { useBottomInset } from '@/hooks/use-bottom-inset';
import { fetchFavoritesForUser, type UserFavorites } from '@/lib/favorites';
import { formatRatingStars, type MediaType } from '@/lib/rating';
import { promptReport } from '@/lib/report';
import supabase from '@/lib/supabase';
import { fetchTitlesWithFallback } from '@/lib/titles';
import { imageUrl } from '@/lib/tmdb';
import { RequestRecSheet } from '@/components/request-rec-sheet';
import { useRequestRec } from '@/hooks/use-request-rec';
import {
    POSTER_STRIP_GAP as REC_STRIP_GAP,
    POSTER_STRIP_H as REC_BETWEEN_POSTER_H,
    POSTER_STRIP_INSET as REC_STRIP_INSET,
    POSTER_STRIP_W as REC_BETWEEN_POSTER_W,
} from '@/theme/poster-layout';
import {
    posterFrame,
    button,
    getPalette,
    radius,
    spacing,
    STATUS_BAR_STYLE,
    typography,
} from '@/theme/theme';

interface FriendProfile {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
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
    // Season scope (null = whole show); shown as a micro "Season N" line
    // under the poster.
    season: number | null;
}

// One written review by this friend, for the "Recent reviews" strip.
// Ordered by when the REVIEW was written/updated (reviews.updated_at), not
// the watch date. spoiler-flagged reviews show a "contains spoilers"
// placeholder instead of the body (the reveal flow lives on the title
// page). rating is the friend's items.rating for the title, if any.
interface RecentReview {
    id: string;
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    body: string;
    containsSpoilers: boolean;
    rating: number | null;
}

// Three-state resolution machine. Renders the whole screen off this:
//   - loading → spinner
//   - not-found → handle resolves to no profile (or fetch failed)
//   - not-friends → profile exists but no friendship row
//   - friends → full profile (Top 5, recs, chats, reviews, library door)
type ResolvedState =
    | { kind: 'loading' }
    | { kind: 'not-found' }
    | { kind: 'not-friends'; profile: FriendProfile }
    | { kind: 'friends'; profile: FriendProfile; friendshipCreatedAt: string };

const AVATAR_SIZE = 80;
// Plum banner zone inside the list header (below the fixed bar, down to the
// arch crest). Taller than the own profile's 74 — the avatar/name sit a
// little lower here so the extra elements (friends-since line, action
// buttons) fit on the sheet with the same arch treatment.
const BANNER_ZONE = 96;
// Avatar straddles the crest, centre a hair above it — same placement rule
// as the own profile, scaled to this screen's 80pt avatar.
const AVATAR_TOP = BANNER_ZONE - AVATAR_SIZE / 2 - 4;

// ── Collapsing-header geometry (mechanism validated on the Stage-1 rig) ──
// The identity block (banner + arch + one-line name/handle) scrolls away on
// the active tab's scroll; the tab bar pins at the top. IDENTITY_H is a HARD
// constant — the name block is fixed-height and the name is numberOfLines={1}
// by construction — because both the header clamp and the tab frames'
// contentContainer paddingTop key off it; if it drifted, the pin seam would.
const NAME_BLOCK_H = 62;
const IDENTITY_H = BANNER_ZONE + ARCH_DEPTH + NAME_BLOCK_H;
const TABS_H = 48;

type TopTab = 'profile' | 'library';

// The "Recs between you" / "Chats between you" strip dimensions live in
// @/theme/poster-layout (imported above), so the strip sections share one
// definition.
const RECS_BETWEEN_LIMIT = 20;
// Recent reviews is a header overview, not a full archive — cap it so the
// (already busy) profile stays bounded.
const RECENT_REVIEWS_LIMIT = 3;
const REVIEW_POSTER_W = 48;
const REVIEW_POSTER_H = Math.round(REVIEW_POSTER_W * 1.5);
const REVIEW_SNIPPET_CHARS = 180;

// "Friends since May 2026" — a single coarse line is enough; specific
// days feel surveillance-y for a casual social product.
function formatFriendsSince(iso: string): string {
    const d = new Date(iso);
    const month = d.toLocaleString('en-US', { month: 'long' });
    return `Friends since ${month} ${d.getFullYear()}`;
}

export default function FriendDetailScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const requestRec = useRequestRec();
    // Pushed screen (edges={['top']}) — pad the list clear of the nav bar.
    const bottomInset = useBottomInset(spacing.lg);
    const { handle: rawHandle, userId: rawTargetUserId } =
        useLocalSearchParams<{ handle: string; userId?: string }>();
    // Handles are stored lowercase in the DB (per the handle column's
    // CHECK constraint). Defensively coerce the URL param so that a
    // capitalized link from somewhere still resolves.
    const handle = (rawHandle ?? '').toLowerCase();
    // When navigated by user id (surfaces with no handle in scope — rec
    // thread, reviews — via goToProfile/UserLink), resolve by id instead of
    // handle. Takes precedence over the placeholder `u` handle segment.
    const targetUserId = rawTargetUserId?.trim() || null;

    const [state, setState] = useState<ResolvedState>({ kind: 'loading' });
    const showLoader = useDeferredLoading(state.kind === 'loading');

    // Light status-bar content while the plum banner header is on screen
    // (main friends branch only — loader/error branches keep the standard
    // bg chrome). Restored to dark on blur so screens navigated to (or
    // back to) never end up with invisible status-bar icons.
    const isFriendsBranch = state.kind === 'friends';
    useFocusEffect(
        useCallback(() => {
            if (!isFriendsBranch) return;
            StatusBar.setBarStyle('light-content');
            return () => StatusBar.setBarStyle(STATUS_BAR_STYLE);
        }, [isFriendsBranch]),
    );
    // Friend's top 5 lists. RLS gates the read at the DB layer (favorites
    // SELECT policy is owner-or-friend); calling this for a non-friend
    // would return an empty array, not throw — but the loader effect
    // below only fires when state.kind === 'friends' anyway.
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

    // ── Top-level tabs + collapsing header (Stage-1 rig mechanism) ──────
    // Library is the default: it's the primary thing you come here for.
    const [topTab, setTopTab] = useState<TopTab>('library');
    // Lazy inversion: the Profile tab's sections (Top 5, recs, chats,
    // reviews) load only once the Profile tab has been OPENED. Flips true
    // on the first switch and never back — the subtree stays mounted after,
    // so nothing refetches on later switches. A glance at the default
    // Library never fires the Profile queries.
    const [profileOpened, setProfileOpened] = useState(false);
    // Whether the chats section has chats — reported by ChatsBetweenSection
    // once its query resolves. Drives the band parity of the strip AFTER it
    // (Top 5), which the parent can't otherwise know.
    const [chatsPresent, setChatsPresent] = useState(false);

    // One shared value PER TAB — independent collapse; each tab owns its
    // own scroll. The header reads the ACTIVE tab's value; switching tabs
    // changes the header instantly (no animation) via the [topTab] dep.
    const libraryY = useSharedValue(0);
    const profileY = useSharedValue(0);
    const onLibraryScroll = useAnimatedScrollHandler((e) => {
        libraryY.value = e.contentOffset.y;
    });
    const onProfileScroll = useAnimatedScrollHandler((e) => {
        profileY.value = e.contentOffset.y;
    });
    const headerStyle = useAnimatedStyle(() => {
        const y = topTab === 'library' ? libraryY.value : profileY.value;
        const clamped = Math.min(Math.max(y, 0), IDENTITY_H);
        return { transform: [{ translateY: -clamped }] };
    }, [topTab]);

    // Asymmetric retention (validated on the rig): LIBRARY keeps its offset
    // across switches (browsing it is the task); PROFILE resets to top on
    // leave (short overview, no place to lose). The reset runs AFTER the
    // switch commits — the profile frame is already hidden, so the jump is
    // invisible by construction. profileY = 0 keeps the header worklet
    // deterministic: reopening Profile always starts expanded.
    const profileScrollRef = useAnimatedRef<Animated.ScrollView>();
    useEffect(() => {
        if (topTab !== 'library') return;
        profileScrollRef.current?.scrollTo({ y: 0, animated: false });
        profileY.value = 0;
    }, [topTab, profileScrollRef, profileY]);

    // ---- Phase 1: resolve friend by handle + friendship status.
    // useFocusEffect so we re-resolve on return (e.g. user accepted a
    // request elsewhere and came back). Stale-guard via `active`.
    useFocusEffect(
        useCallback(() => {
            if (!handle && !targetUserId) {
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

                    // Resolve by id when navigated by userId, else by handle.
                    // RLS hides blocked/deleted profiles either way → null →
                    // the same graceful not-found state below.
                    const profilesQuery = supabase
                        .from('profiles')
                        .select('id, display_name, handle, avatar_url, bio');
                    const { data: profileData, error: profileError } = await (
                        targetUserId
                            ? profilesQuery.eq('id', targetUserId)
                            : profilesQuery.eq('handle', handle)
                    ).maybeSingle();
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
                        bio: profileData.bio,
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
        }, [handle, targetUserId, router]),
    );

    // The friend's library items are fetched by <FriendLibrary> (mounted in
    // the default Library tab), so its query fires on mount — eager, which is
    // correct: the library is the primary content. The PROFILE tab's queries
    // below are the lazy side of the inversion, gated on profileOpened.

    // ---- Phase 2b: fetch the friend's top 5 lists. Gated on the Profile
    // tab having been opened (lazy inversion). Best-effort: a transient read
    // failure degrades to "no top 5 shown," not a broken profile screen.
    useEffect(() => {
        if (state.kind !== 'friends' || !profileOpened) {
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
    }, [state, profileOpened]);

    // ---- Phase 2c: recommendation history between the two users (both
    // directions). Gated on profileOpened (lazy inversion). Best-effort: a
    // failure degrades to "no strip," not a broken profile. RLS
    // (recommendations_select_party: from = auth.uid() OR to = auth.uid())
    // already returns both directions — every row here has me as one party.
    useEffect(() => {
        if (state.kind !== 'friends' || !profileOpened) {
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
                    .select('id, from_user_id, to_user_id, tmdb_id, media_type, sent_at, season')
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
                    season: typeof r.season === 'number' ? r.season : null,
                }));
                if (active) setRecsBetween(built);
            } catch (err) {
                console.warn('recs-between fetch failed:', err);
            }
        })();
        return () => {
            active = false;
        };
    }, [state, profileOpened]);

    // ---- Phase 2d: this friend's recently-WRITTEN reviews. Gated on
    // profileOpened (lazy inversion). Ordered by reviews.updated_at (when
    // the review was written/edited), NOT watch date. RLS
    // (reviews_select_own_or_visible_via_item) only returns reviews whose
    // parent items row is friends-visible — same privacy model as the rest
    // of the screen. Best-effort.
    useEffect(() => {
        if (state.kind !== 'friends' || !profileOpened) {
            setRecentReviews(null);
            return;
        }
        const friendId = state.profile.id;
        let active = true;
        (async () => {
            try {
                const { data: reviewRows, error: revErr } = await supabase
                    .from('reviews')
                    .select('id, tmdb_id, media_type, body, contains_spoilers, updated_at')
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
                        id: r.id,
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
    }, [state, profileOpened]);

    // ---- Render branches per state.

    // Parameterized: the loader/error branches render it accent-on-bg as
    // before; the main friends branch renders it white on the plum banner.
    const backButton = (color: string) => (
        <Pressable
            onPress={() => router.back()}
            hitSlop={spacing.sm}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
            <CaretLeft
                color={color}
                size={28}
            />
        </Pressable>
    );

    if (showLoader) {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton(palette.accent)}</View>
                <FullScreenLoader />
            </SafeAreaView>
        );
    }

    // Unreachable: showLoader (busy) covers the 'loading' state — narrows it
    // out of the union for the branches below.
    if (state.kind === 'loading') return null;

    if (state.kind === 'not-found') {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                <View style={styles.headerBar}>{backButton(palette.accent)}</View>
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
                        {targetUserId
                            ? "This profile isn't available."
                            : `@${rawHandle ?? 'this handle'} doesn't exist on Seen.`}
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
                <View style={styles.headerBar}>{backButton(palette.accent)}</View>
                <View style={styles.profileBlock}>
                    <Avatar
                        avatarUrl={state.profile.avatarUrl}
                        displayName={state.profile.displayName}
                        seedId={state.profile.id}
                        size={AVATAR_SIZE}
                    />
                    <Text
                        style={[typography.headingDisplay, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {state.profile.displayName}
                    </Text>
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                    >
                        @{state.profile.handle}
                    </Text>
                    {state.profile.bio ? (
                        <Text
                            style={[
                                typography.body,
                                styles.bioText,
                                { color: palette.textMuted },
                            ]}
                        >
                            {state.profile.bio}
                        </Text>
                    ) : null}
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

    // Alternating full-width band colours for the three consecutive poster
    // strips (Top 5, Recs between, Chats between) so they don't merge into
    // one wall of covers. A strip gets the ALT tone when the number of
    // present strips before it is even, the BASE (page) tone when it's odd —
    // so adjacent strips always differ, and the pattern stays correct when a
    // middle strip is conditionally absent (the instability the fixed
    // rhythm had). Recent reviews stays on the base tone: it's a vertical
    // list, not a strip, so it carries no merge risk. Kept to a quiet tonal
    // step within the plum system (surfaceAlt over bg), not a colour scheme.
    //
    // The bands are SQUARE and FULL-WIDTH by decision — do not round or inset
    // them. Two reasons:
    //   1. The strips inside bleed past the screen edge with a negative
    //      margin. An inset rounded band would either clip that bleed or let
    //      the strips spill past its corners — full-bleed and inset rounded
    //      cards are mutually exclusive.
    //   2. In this app roundedness MEANS "contained object" (friends rows,
    //      the title page's social cards, the library card below). A band is
    //      the page itself, not an object on it. Round everything and
    //      roundedness stops meaning anything.
    // Section order (Profile tab): Recs between you → Chats between you →
    // Top 5 → Recent reviews. Shared-with-you content first; their all-time
    // Top 5 is context below it. Chats presence is async (the section owns
    // its query), so it reports presence via onPresenceChange and Top 5's
    // parity keys off that state — the tone may settle once on first load
    // as the chats query resolves.
    const top5Present =
        favorites.movies.length > 0 || favorites.tv.length > 0;
    const recsPresent = !!(recsBetween && recsBetween.length > 0);
    const stripBand = (presentBefore: number) =>
        presentBefore % 2 === 0 ? palette.surfaceAlt : palette.bg;
    const recsBand = stripBand(0);
    const chatsBand = stripBand(recsPresent ? 1 : 0);
    const top5Band = stripBand(
        (recsPresent ? 1 : 0) + (chatsPresent ? 1 : 0),
    );

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

    // Block user — overflow menu → confirm → block_user RPC (atomic: records
    // the block, removes the friendship, clears pending requests both ways).
    // Silent (no notification). Reuses the `removing` in-flight guard since,
    // like unfriend, it ends by routing away. On success the profile becomes
    // block-hidden, so we leave for the Friends tab.
    async function performBlock() {
        if (removing) return;
        setRemoving(true);
        try {
            const { error } = await supabase.rpc('block_user', {
                other_user_id: profile.id,
            });
            if (error) throw error;
            router.replace({ pathname: '/friends' });
        } catch (err) {
            console.error('block user failed:', err);
            setRemoving(false);
            Alert.alert('Could not block user', 'Please try again.');
        }
    }

    function confirmBlock() {
        Alert.alert(
            `Block @${profile.handle}?`,
            "You won't see each other's profiles or recommendations, and they'll be removed as a friend.",
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Block',
                    style: 'destructive',
                    onPress: () => void performBlock(),
                },
            ],
        );
    }

    function openFriendMenu() {
        if (removing) return;
        Alert.alert(`@${profile.handle}`, undefined, [
            {
                text: 'Report user',
                onPress: () =>
                    promptReport({
                        type: 'profile',
                        id: profile.id,
                        reportedUserId: profile.id,
                        title: 'Report user',
                    }),
            },
            {
                text: 'Remove friend',
                style: 'destructive',
                onPress: confirmRemoveFriend,
            },
            {
                text: 'Block user',
                style: 'destructive',
                onPress: confirmBlock,
            },
            { text: 'Cancel', style: 'cancel' },
        ]);
    }

    // Profile TAB content — friends-since + the action buttons at top (moved
    // out of the shared header: they're profile actions, not identity), then
    // the sections in order: Recs between you, Chats between you, Top 5,
    // Recent reviews. The identity block (banner, arch, avatar, name) lives
    // in the collapsing header overlay in the return below, shared by both
    // tabs.
    const profileTabContent = (
        <>
            {/* bg gap under the tab row so the first band doesn't read as
                the tabs' background. */}
            <View style={styles.tabContentGap} />
            <View style={styles.profileBlock}>
                {/* Bio sits in the SCROLLABLE profile content, not the
                    identity block above: IDENTITY_H is a hard constant
                    (the collapse clamp and content paddingTop key off it),
                    so variable-height text can't join the name/handle
                    without breaking the pin seam. Absent when null — no
                    empty line. */}
                {profile.bio ? (
                    <Text
                        style={[
                            typography.body,
                            styles.bioText,
                            { color: palette.textMuted },
                        ]}
                    >
                        {profile.bio}
                    </Text>
                ) : null}
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
                        {
                            backgroundColor: palette.accent,
                            borderColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <PaperPlaneTilt
                        color={palette.textInverse}
                        size={16}
                    />
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Recommend something
                    </Text>
                </Pressable>
                {/* Untied request: nudges this friend to send a rec. Ghost
                    row (matching the title page's "Chat about it") — muted
                    icon + label, no fill/border, so "Recommend something"
                    is the single clear primary and this is the quiet
                    secondary. */}
                <Pressable
                    onPress={() =>
                        requestRec.open(profile.id, profile.displayName)
                    }
                    style={({ pressed }) => [
                        styles.requestButton,
                        { opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <ChatText
                        color={palette.textMuted}
                        size={16}
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

            {/* Recs between you — the recommendation history both
                directions, most-recent first. Hidden entirely when there
                are none. Each card: poster + "From you" / "From {name}"
                (sender). Tapping opens the rec view (the conversation);
                for a rec you sent, that view shows the sender perspective.
                Full-bleed horizontal strip, matching Top 5 / where-to-watch. */}
            {recsPresent && (
                <View
                    style={[
                        styles.recsBetweenSection,
                        { backgroundColor: recsBand },
                    ]}
                >
                    <Text
                        style={[
                            typography.overline,
                            styles.recsBetweenHeading,
                            { color: palette.textMuted },
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
                                {r.season !== null ? (
                                    <Text
                                        style={[
                                            typography.micro,
                                            { color: palette.textMuted },
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {r.season === 0
                                            ? 'Specials'
                                            : `Season ${r.season}`}
                                    </Text>
                                ) : null}
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}

            {/* Chats between you — directly below Recs between you, above
                Top 5. Self-contained component; renders nothing when the
                pair has no chats. It paints its own full-width band
                (chatsBand) when it renders, and reports its presence up so
                Top 5's band parity (the strip AFTER it) stays correct. */}
            <ChatsBetweenSection
                friendId={profile.id}
                friendName={profile.displayName}
                bandColor={chatsBand}
                onPresenceChange={setChatsPresent}
            />

            {/* Friend's top 5 sections — their all-time context, below the
                shared-with-you strips. Conditional so no empty band paints
                when the friend has no favorites curated. */}
            {top5Present && (
                <View
                    style={[styles.sectionBand, { backgroundColor: top5Band }]}
                >
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
                            typography.overline,
                            { color: palette.textMuted },
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
                                // Long-press to Report this friend's review
                                // (App Store 1.2). Always someone else's review
                                // on a friend's profile, so no self-check needed.
                                onLongPress={() =>
                                    promptReport({
                                        type: 'review',
                                        id: r.id,
                                        reportedUserId: profile.id,
                                        title: 'Report review',
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
                                {/* Visible Report affordance (App Store 1.2) —
                                    primary path; the row also long-presses.
                                    Always the friend's review (not yours). */}
                                <Pressable
                                    onPress={() =>
                                        promptReport({
                                            type: 'review',
                                            id: r.id,
                                            reportedUserId: profile.id,
                                            title: 'Report review',
                                        })
                                    }
                                    hitSlop={spacing.sm}
                                    accessibilityRole="button"
                                    accessibilityLabel="Report review"
                                    style={({ pressed }) => [
                                        styles.reviewReportButton,
                                        pressed && { opacity: 0.5 },
                                    ]}
                                >
                                    <DotsThree
                                        color={palette.textMuted}
                                        size={18}
                                    />
                                </Pressable>
                            </Pressable>
                        );
                    })}
                </View>
            )}

        </>
    );

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {/* Fixed chrome on the plum banner — the plum reaches the
                physical top of the screen (safe area included); chevron and
                overflow go white. Always on screen; the identity block below
                slides up and clips beneath it. */}
            <SafeAreaView
                edges={['top']}
                style={{ backgroundColor: palette.accent }}
            >
                <View style={styles.headerBar}>
                    {backButton(palette.textInverse)}
                    <View style={styles.headerBarRight}>
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
                            <DotsThreeVertical
                                size={22}
                                color={palette.textInverse}
                            />
                        </Pressable>
                    </View>
                </View>
            </SafeAreaView>

            {/* Collapse zone (Stage-1 rig mechanism, validated on device).
                overflow hidden so the identity block clips cleanly at the top
                edge as it slides away. Both tab frames stay MOUNTED (scroll +
                filter state preserved); the inactive one is invisible and
                untouchable. Frame top = TABS_H so each list's own sticky pins
                below the pinned tab bar; content paddingTop = IDENTITY_H so
                expanded content starts below the full header. */}
            <View style={styles.collapseZone}>
                <View
                    style={[
                        styles.tabFrame,
                        topTab !== 'library' && styles.tabFrameHidden,
                    ]}
                    pointerEvents={topTab === 'library' ? 'auto' : 'none'}
                >
                    {/* Default tab → mounts immediately → its items query
                        fires on mount (eager, correct: it's the primary
                        content). Library RETAINS its scroll across switches. */}
                    <FriendLibrary
                        friendId={profile.id}
                        displayName={profile.displayName}
                        handle={profile.handle}
                        onScroll={onLibraryScroll}
                        contentTopInset={IDENTITY_H}
                    />
                </View>

                <View
                    style={[
                        styles.tabFrame,
                        topTab !== 'profile' && styles.tabFrameHidden,
                    ]}
                    pointerEvents={topTab === 'profile' ? 'auto' : 'none'}
                >
                    {/* Lazy: mounts on FIRST open of the Profile tab (its
                        section queries are gated on profileOpened too) and
                        stays mounted after. Resets to top on leave (see the
                        reset effect above). */}
                    {profileOpened && (
                        <Animated.ScrollView
                            ref={profileScrollRef}
                            onScroll={onProfileScroll}
                            scrollEventThrottle={16}
                            contentContainerStyle={{
                                paddingTop: IDENTITY_H,
                                paddingBottom: bottomInset,
                            }}
                            showsVerticalScrollIndicator={false}
                        >
                            {profileTabContent}
                        </Animated.ScrollView>
                    )}
                </View>

                {/* Header overlay — identity block + tab bar, translating up
                    on the active tab's scroll (clamped so the tabs pin).
                    box-none so only children catch touches: the identity is
                    pointerEvents none (drags over it scroll the list
                    beneath); the tab bar is tappable and OPAQUE (content
                    passes under it once collapsed). */}
                <Animated.View
                    style={[styles.headerOverlay, headerStyle]}
                    pointerEvents="box-none"
                >
                    <View
                        style={[
                            styles.identityBlock,
                            { backgroundColor: palette.bg },
                        ]}
                        pointerEvents="none"
                    >
                        <View
                            style={[
                                styles.bannerZone,
                                { backgroundColor: palette.accent },
                            ]}
                        />
                        <ArchCap />
                        <View style={styles.archAvatar}>
                            <Avatar
                                avatarUrl={profile.avatarUrl}
                                displayName={profile.displayName}
                                seedId={profile.id}
                                size={AVATAR_SIZE}
                            />
                        </View>
                        <View style={styles.nameBlock}>
                            <Text
                                style={[
                                    // Display face at heading size — the
                                    // friend-profile header name is a V2
                                    // display-tier role (identical to
                                    // heading while V1 is active).
                                    typography.headingDisplay,
                                    { color: palette.text },
                                ]}
                                numberOfLines={1}
                            >
                                {profile.displayName}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                @{profile.handle}
                            </Text>
                        </View>
                    </View>

                    <View
                        style={[styles.tabsRow, { backgroundColor: palette.bg }]}
                    >
                        <TabButton
                            label="Profile"
                            active={topTab === 'profile'}
                            onPress={() => {
                                setTopTab('profile');
                                // Lazy gate: first open mounts the tab's
                                // subtree + fires its section queries.
                                if (!profileOpened) setProfileOpened(true);
                            }}
                            palette={palette}
                        />
                        <TabButton
                            label="Library"
                            active={topTab === 'library'}
                            onPress={() => setTopTab('library')}
                            palette={palette}
                        />
                    </View>
                </Animated.View>
            </View>

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

// Large-text top-level tab — heading 22/600, active in full colour with a
// 2pt accent underline, inactive muted. Deliberately a different visual
// register from the pill SegmentedControl inside the Library tab (validated
// on the tabs prototype): big underlined bare text vs small wash-filled pill.
function TabButton({
    label,
    active,
    onPress,
    palette,
}: {
    label: string;
    active: boolean;
    onPress: () => void;
    palette: ReturnType<typeof getPalette>;
}) {
    return (
        <Pressable
            onPress={onPress}
            hitSlop={spacing.sm}
            style={({ pressed }) => [
                styles.tabButton,
                pressed && { opacity: 0.6 },
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
        >
            <Text
                style={[
                    typography.heading,
                    { color: active ? palette.text : palette.textMuted },
                ]}
            >
                {label}
            </Text>
            {/* Always rendered (height reserved) so there's no jump; accent
                only when active. */}
            <View
                style={[
                    styles.tabUnderline,
                    { backgroundColor: active ? palette.accent : 'transparent' },
                ]}
            />
        </Pressable>
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
        // Push the overflow menu to the right edge of the header bar. The
        // back button sits at the left; this slot is its mirror.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        marginLeft: 'auto',
    },
    overflowButton: {
        padding: spacing.xs,
    },
    // Plum banner zone inside the list header — from below the fixed bar
    // down to the arch crest.
    bannerZone: {
        width: '100%',
        height: BANNER_ZONE,
    },
    // Avatar straddling the banner/sheet boundary. box-none so the
    // full-width wrapper doesn't eat taps beside the avatar.
    archAvatar: {
        position: 'absolute',
        top: AVATAR_TOP,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 2,
    },
    // Actions block at the top of the Profile TAB — friends-since line +
    // the Recommend/Request buttons (moved here from the identity header;
    // they're profile actions, not identity). Centered, matching the old
    // under-avatar treatment.
    // ── Collapsing header + tabs (Stage-1 rig styles) ──────────────────
    collapseZone: {
        flex: 1,
        position: 'relative',
        // Clip the identity block as it translates up past the zone's top
        // edge (iOS defaults to overflow visible — without this the banner
        // and avatar would ride up OVER the fixed plum bar).
        overflow: 'hidden',
    },
    tabFrame: {
        // Frame top = TABS_H: each list's own native sticky pins at its
        // frame top, i.e. exactly below where the tab bar pins.
        position: 'absolute',
        top: TABS_H,
        left: 0,
        right: 0,
        bottom: 0,
    },
    tabFrameHidden: {
        // Hidden-not-unmounted: scroll offset and filter state survive the
        // switch (pointerEvents flips off alongside, in the render).
        opacity: 0,
    },
    headerOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
    },
    identityBlock: {
        // Hard-coded height — IDENTITY_H is load-bearing for the clamp and
        // the frames' paddingTop; the name is one line by construction.
        height: IDENTITY_H,
    },
    nameBlock: {
        height: NAME_BLOCK_H,
        alignItems: 'center',
        paddingTop: spacing.xs,
        gap: spacing.xs,
    },
    tabsRow: {
        // Centred large-text tabs — they belong to the centred identity
        // block above, not the content. Opaque: list content scrolls
        // beneath once collapsed.
        height: TABS_H,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: spacing.xl,
    },
    tabButton: { alignItems: 'center' },
    tabUnderline: {
        height: 2,
        alignSelf: 'stretch',
        marginTop: spacing.xxs,
        borderRadius: radius.full,
    },
    tabContentGap: { height: spacing.base },
    profileBlock: {
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingTop: spacing.xs,
        paddingBottom: spacing.lg,
        gap: spacing.xs,
    },
    // Shared full-width section band. Vertical rhythm lives HERE and only
    // here — paddingVertical base (16), no margins anywhere — so the gap
    // between any two adjacent sections is a uniform 32 (16 + 16) that can't
    // accumulate and doesn't shift when a conditional section drops out. No
    // horizontal padding: the strip inside bleeds full-width to the band's
    // edges (= the screen edges), and each strip's own heading carries its
    // base inset. The band's backgroundColor (base vs alt tone) is applied
    // inline per section for the alternating rhythm.
    sectionBand: {
        paddingVertical: spacing.base,
    },
    recsBetweenSection: {
        // Heading + strip block. Same band rhythm as sectionBand
        // (paddingVertical base, no margin); paddingHorizontal insets the
        // heading only — the strip's -REC_STRIP_INSET scroll margin cancels
        // it so the strip still bleeds full width across the band.
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.base,
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
        ...posterFrame,
        width: REC_BETWEEN_POSTER_W,
        height: REC_BETWEEN_POSTER_H,
        borderRadius: radius.sm,
    },
    recentReviewsSection: {
        // Heading + capped vertical list. Same band rhythm as the strips
        // (paddingVertical base, no margins); stays on the BASE tone (no
        // alt band) because a vertical review list is structurally distinct
        // from the poster strips and carries no merge risk. paddingHorizontal
        // insets both heading and rows. Inner gap separates heading + rows.
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.base,
        gap: spacing.sm,
    },
    reviewRow: {
        flexDirection: 'row',
        gap: spacing.md,
        alignItems: 'flex-start',
    },
    reviewPoster: {
        ...posterFrame,
        width: REVIEW_POSTER_W,
        height: REVIEW_POSTER_H,
        borderRadius: radius.sm,
    },
    reviewText: {
        flex: 1,
        gap: spacing.xs,
    },
    reviewReportButton: {
        // Trailing "⋯" on the review row — reviewText's flex:1 pushes it to
        // the right edge; row aligns flex-start so it sits top-right. Quiet.
        padding: spacing.xs,
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
    // Bio: descriptive text, muted, centred with side padding so a full
    // 160-char bio wraps as a readable measure. No accent (BRANDING: a
    // bio is not an action).
    bioText: {
        textAlign: 'center',
        paddingHorizontal: spacing.base,
        marginTop: spacing.xs,
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
    // Primary action — filled accent, no visible border. Mirrors the
    // title screen's recommendButton treatment (filled accent, radius.sm,
    // md vertical padding) so "Recommend something" reads the same across
    // screens. Fill + matching-colour border applied inline; the border is
    // the same colour as the fill (so invisible) purely to keep an
    // identical box height to the outlined secondary below — they're a
    // matched, full-width pair. alignSelf stretch fills the profileBlock's
    // base padding so both buttons share the same width + edges.
    recommendButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'stretch',
        gap: spacing.sm,
        // Shared button geometry token — this block was missed by the
        // original 19-site sweep; adopted here.
        paddingVertical: button.paddingVertical,
        paddingHorizontal: spacing.base,
        borderRadius: button.borderRadius,
        borderWidth: 1.5,
        marginTop: spacing.md,
    },
    // Quiet secondary — GHOST row (no fill/border, muted icon + label),
    // matching the title page's "Chat about it" treatment, so the filled
    // "Recommend something" above is the single clear primary. md gap
    // below the primary = the standardized primary/ghost breathing room.
    requestButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'stretch',
        gap: spacing.xs,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.base,
        marginTop: spacing.md,
    },
});
