import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
    ChevronLeft,
    ChevronRight,
    MessageSquarePlus,
    MoreHorizontal,
    MoreVertical,
    Send,
    UserPlus,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Pressable,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Same library glyph the nav bar uses (assets/images/navbar/icon-library.svg)
// so the profile's Library card and the tab bar read as one mark.
import LibraryNavIcon from '../../../assets/images/navbar/icon-library.svg';
import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { ArchCap } from '@/components/profile-arch';
import { ChatsBetweenSection } from '@/components/chats-between-section';
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
    button,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface FriendProfile {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
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
            return () => StatusBar.setBarStyle('dark-content');
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
                        .select('id, display_name, handle, avatar_url');
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

    // The friend's library items are no longer fetched here — the library
    // moved to its own screen (src/app/friends/[handle]/library.tsx), which
    // fires the items query on mount. A glance-only profile visit no longer
    // pays for it.

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
    }, [state]);

    // ---- Render branches per state.

    // Parameterized: the loader/error branches render it accent-on-bg as
    // before; the main friends branch renders it white on the plum banner.
    const backButton = (color: string) => (
        <Pressable
            onPress={() => router.back()}
            hitSlop={spacing.sm}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
            <ChevronLeft
                color={color}
                size={28}
                strokeWidth={ICON_STROKE_WIDTH}
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
    const top5Present =
        favorites.movies.length > 0 || favorites.tv.length > 0;
    const recsPresent = !!(recsBetween && recsBetween.length > 0);
    const stripBand = (presentBefore: number) =>
        presentBefore % 2 === 0 ? palette.surfaceAlt : palette.bg;
    const top5Band = stripBand(0);
    const recsBand = stripBand(top5Present ? 1 : 0);
    const chatsBand = stripBand(
        (top5Present ? 1 : 0) + (recsPresent ? 1 : 0),
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

    // Profile content — the whole scrolling body. Plum banner + arched
    // sheet: the banner continues the fixed bar's plum down to the arch
    // crest; the avatar straddles the crest; name, handle, friends-since and
    // the action buttons sit on the sheet below, then Top 5, recs, chats,
    // reviews, and the library door.
    const profileContent = (
        <>
            {/* Top-bounce cap: plum extended above the header so an iOS
                overscroll at the top shows plum, never a bg seam. */}
            <View
                style={[styles.bounceCap, { backgroundColor: palette.accent }]}
            />
            <View
                style={[styles.bannerZone, { backgroundColor: palette.accent }]}
            />
            <ArchCap />
            {/* Avatar straddling the crest — absolute over the banner/sheet
                boundary. */}
            <View style={styles.archAvatar} pointerEvents="box-none">
                <Avatar
                    avatarUrl={profile.avatarUrl}
                    displayName={profile.displayName}
                    seedId={profile.id}
                    size={AVATAR_SIZE}
                />
            </View>
            <View style={styles.profileBlock}>
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
                        {
                            backgroundColor: palette.accent,
                            borderColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Send
                        color={palette.textInverse}
                        size={16}
                        strokeWidth={ICON_STROKE_WIDTH}
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

            {/* Friend's top 5 sections. Full-width band (first strip → ALT
                tone) so it separates from the Recs strip below. Conditional
                so no empty band paints when the friend has no favorites. */}
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
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}

            {/* Chats between you — directly below Recs between you, above
                Recent reviews. Self-contained component; renders nothing when
                the pair has no chats. It paints its own full-width band
                (chatsBand, computed from how many strips precede it) only
                when it renders, so the alternation stays correct without the
                parent knowing this async section's presence. */}
            <ChatsBetweenSection
                friendId={profile.id}
                friendName={profile.displayName}
                bandColor={chatsBand}
            />

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
                                    <MoreHorizontal
                                        color={palette.textMuted}
                                        size={18}
                                        strokeWidth={ICON_STROKE_WIDTH}
                                    />
                                </Pressable>
                            </Pressable>
                        );
                    })}
                </View>
            )}

            {/* Library — pushes the friend's whole library to its own screen
                (search + status tabs + filter chips + grid + view controls).
                Kept off the profile so a glance-only visit doesn't pay for
                the items query. Params hand the friend across so the library
                screen needs no resolve round-trip. Treated as a card with an
                accent icon tile — this is the thing you'd most want to browse,
                so it carries real weight (not the thin settings row it was),
                without borrowing the solid-plum register of "Recommend". */}
            <View style={styles.libraryCardBand}>
                <Pressable
                    onPress={() =>
                        router.push({
                            pathname: '/friends/[handle]/library',
                            params: {
                                handle: profile.handle,
                                userId: profile.id,
                                name: profile.displayName,
                                avatarUrl: profile.avatarUrl ?? '',
                            },
                        })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`${profile.displayName}'s library`}
                    style={({ pressed }) => [
                        styles.libraryCard,
                        { backgroundColor: palette.surfaceElevated },
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <View
                        style={[
                            styles.libraryCardIconTile,
                            { backgroundColor: palette.accentWash },
                        ]}
                    >
                        <LibraryNavIcon
                            color={palette.accent}
                            width={22}
                            height={22}
                        />
                    </View>
                    <Text
                        style={[
                            typography.heading,
                            styles.libraryCardTitle,
                            { color: palette.text },
                        ]}
                        numberOfLines={1}
                    >
                        Library
                    </Text>
                    <ChevronRight
                        color={palette.textMuted}
                        size={22}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
            </View>
        </>
    );

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            {/* Fixed chrome on the plum banner — the plum reaches the
                physical top of the screen (safe area included); chevron and
                overflow go white. The view controls live on the library
                screen (meaningless here), so the right slot holds only the
                overflow menu. */}
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
                            <MoreVertical
                                size={22}
                                color={palette.textInverse}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    </View>
                </View>
            </SafeAreaView>

            {/* With the library grid gone, the profile no longer needs a
                sticky-header FlatList — its remaining sections (Top 5, recs,
                chats, reviews, the library door) are all bounded, so a plain
                ScrollView carries them. Section markup + margins are carried
                across unchanged. */}
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: bottomInset },
                ]}
                showsVerticalScrollIndicator={false}
            >
                {profileContent}
            </ScrollView>

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
    // Top-bounce cap: plum extended 600pt above the list header so an iOS
    // overscroll never exposes a bg seam above the banner.
    bounceCap: {
        position: 'absolute',
        top: -600,
        left: 0,
        right: 0,
        height: 600,
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
    profileBlock: {
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        // On the sheet, directly after the arch cap; xs (was base) pulls
        // the name up closer under the avatar — ~21pt from its bottom edge
        // (this avatar clears the cap higher than the own profile's, so
        // the smaller pad here lands the SAME visual gap as its md there).
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
    // Library door — the card sits in a base-tone band so it shares the
    // 32pt section rhythm and gets a horizontal gutter (the card is inset,
    // not full-bleed like the strips).
    libraryCardBand: {
        paddingVertical: spacing.base,
        paddingHorizontal: spacing.base,
    },
    // The card itself — a plum-tinted surface (surfaceElevated) with an
    // accent icon tile. Presence from fill + radius + the tile + heading-tier
    // title, deliberately NOT the solid-plum register of "Recommend". Title
    // flexes so the chevron pins right.
    libraryCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.base,
        padding: spacing.base,
        borderRadius: radius.md,
    },
    libraryCardIconTile: {
        width: 44,
        height: 44,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    libraryCardTitle: {
        flex: 1,
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
    scrollContent: {
        // Whole-screen ScrollView: horizontal insets live on the individual
        // sections, which each manage their own gutters. The bottom cushion
        // is applied inline via useBottomInset (nav-bar clearance).
    },
});
