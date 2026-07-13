import { useFocusEffect, useRouter } from 'expo-router';
import {
    ChevronRight,
    Plus,
    Search as SearchIcon,
    X,
} from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import {
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { Chip } from '@/components/chip';
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import { ScreenHeader } from '@/components/screen-header';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { shareInvite } from '@/lib/invite';
import supabase from '@/lib/supabase';
import {
    button,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// A friend's single most recent friend-visible activity, from
// get_friends_activity() (one row per friend who has any). Null when the
// friend has no qualifying activity — such friends render as before.
interface FriendActivity {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    status: 'watchlist' | 'watching' | 'watched';
    // 1–10 half-star scale, nullable.
    rating: number | null;
    titleName: string;
    activityAt: string;
}

interface FriendRow {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    // friendships.created_at — for the "Recently added" sort.
    friendshipCreatedAt: string;
    // Latest friend-visible activity, or null if the friend has none.
    activity: FriendActivity | null;
}

type FriendSort = 'recentlyAdded' | 'name' | 'recentActivity';

const FRIEND_SORTS: { value: FriendSort; label: string }[] = [
    { value: 'recentlyAdded', label: 'Recently added' },
    { value: 'recentActivity', label: 'Activity' },
    { value: 'name', label: 'Name' },
];

// Shape returned by the get_friends_activity() RPC (one row per active
// friend). Mapped onto FriendRow.activity by friend_id.
interface FriendActivityRow {
    friend_id: string;
    tmdb_id: number;
    media_type: 'movie' | 'tv';
    status: 'watchlist' | 'watching' | 'watched';
    rating: number | null;
    title_name: string;
    activity_at: string;
}

// Coarse relative time for the activity line: 2h, 3d, 2w, 1mo. Local to this
// screen ON PURPOSE — the shared relativeTimestamp (thread/shared.ts) stops at
// days then shows a date, and it backs rec/chat message timestamps, so adding
// weeks/months there would redesign two shipped surfaces. Sub-minute reads as
// "now".
function relativeActivity(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const minutes = diffMs / (1000 * 60);
    const hours = minutes / 60;
    const days = hours / 24;
    const weeks = days / 7;
    const months = days / 30;
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${Math.floor(minutes)}m`;
    if (hours < 24) return `${Math.floor(hours)}h`;
    if (days < 7) return `${Math.floor(days)}d`;
    if (days < 30) return `${Math.floor(weeks)}w`;
    return `${Math.floor(months)}mo`;
}

// Rating (1–10 half-star scale) → compact numeric stars, trailing .0 dropped:
// 8 → "4", 9 → "4.5", 10 → "5", 7 → "3.5". Badge register, not glyph stars.
function formatStars(rating: number): string {
    const stars = rating / 2;
    return Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
}

// The activity line copy, driven by status + rating.
function formatActivityLine(activity: FriendActivity): string {
    const { status, rating, titleName } = activity;
    if (status === 'watching') return `Watching ${titleName}`;
    if (status === 'watched') {
        return rating != null
            ? `Rated ${titleName} ${formatStars(rating)}★`
            : `Watched ${titleName}`;
    }
    return `Added ${titleName} to their watchlist`;
}

// Larger than a list-row avatar (was 44) — taller than the two-line text
// block, so it reads as the anchor of the card.
const AVATAR_SIZE = 56;

export default function FriendsScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const tabBarInset = useFloatingTabBarInset();
    const { count: unreadCount } = useUnreadCount();

    const [friends, setFriends] = useState<FriendRow[]>([]);
    const [pendingIncoming, setPendingIncoming] = useState(0);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    const [sortBy, setSortBy] = useState<FriendSort>('recentlyAdded');

    // Local name/handle filter — mirrors the library + friend-library
    // local-search pattern (borderless bar, Cancel-on-focus, inline
    // clear-X). localFocused drives the Cancel sibling; the ref lets
    // Cancel blur the input.
    const [localQuery, setLocalQuery] = useState('');
    const [localFocused, setLocalFocused] = useState(false);
    const localSearchInputRef = useRef<TextInput | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Friendships + count of incoming pending requests in parallel.
            // Friendships are stored as lexicographic pairs (user_a < user_b),
            // so we OR-match either side and pick the other party per row.
            const [friendshipsResult, pendingResult, activityResult] =
                await Promise.all([
                supabase
                    .from('friendships')
                    .select('user_a_id, user_b_id, created_at')
                    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
                    .order('created_at', { ascending: false }),
                supabase
                    .from('friend_requests')
                    .select('id', { count: 'exact', head: true })
                    .eq('to_user_id', userId),
                // Latest friend-visible activity per friend (one row each,
                // friends with none absent). SECURITY INVOKER RPC — RLS scopes
                // it to my friends' friends-visible items. Parallel here, so no
                // extra round trip.
                //
                // Cast: this RPC is verified on the DB but not yet in the
                // generated database.types.ts (created by hand in the SQL
                // editor), so the typed rpc() overload can't see it. Regenerate
                // types (supabase gen types) to remove the cast — runtime is
                // correct either way.
                supabase.rpc(
                    'get_friends_activity' as never,
                ) as unknown as PromiseLike<{
                    data: FriendActivityRow[] | null;
                    error: { message: string } | null;
                }>,
            ]);
            if (friendshipsResult.error) throw friendshipsResult.error;
            if (pendingResult.error) throw pendingResult.error;
            if (activityResult.error) throw activityResult.error;

            setPendingIncoming(pendingResult.count ?? 0);

            const rows = friendshipsResult.data ?? [];
            const createdAtById = new Map<string, string>();
            const otherIds = rows.map((r) => {
                const other =
                    r.user_a_id === userId ? r.user_b_id : r.user_a_id;
                createdAtById.set(other, r.created_at);
                return other;
            });

            // Latest activity per friend, keyed by friend_id. The RPC returns
            // at most one row per friend; friends absent from it have no
            // activity and get null below.
            const activityById = new Map<string, FriendActivity>();
            for (const a of activityResult.data ?? []) {
                activityById.set(a.friend_id, {
                    tmdbId: a.tmdb_id,
                    mediaType: a.media_type,
                    status: a.status,
                    rating: a.rating,
                    titleName: a.title_name,
                    activityAt: a.activity_at,
                });
            }

            if (otherIds.length === 0) {
                setFriends([]);
                return;
            }

            const { data: profiles, error: profilesError } = await supabase
                .from('profiles')
                .select('id, handle, display_name, avatar_url')
                .in('id', otherIds);
            if (profilesError) throw profilesError;

            const byId = new Map(profiles?.map((p) => [p.id, p]) ?? []);

            const friendRows: FriendRow[] = otherIds
                .map((id) => byId.get(id))
                .filter((p): p is NonNullable<typeof p> => p !== undefined)
                .map((p) => ({
                    userId: p.id,
                    handle: p.handle,
                    displayName: p.display_name,
                    avatarUrl: p.avatar_url,
                    friendshipCreatedAt: createdAtById.get(p.id) ?? '',
                    activity: activityById.get(p.id) ?? null,
                }));

            setFriends(friendRows);
        } catch (err) {
            console.error('friends fetch failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load friends');
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            load();
        }, [load]),
    );

    function renderFriendRow({ item }: { item: FriendRow }) {
        return (
            <Pressable
                onPress={() => router.push(`/friends/${item.handle}`)}
                style={({ pressed }) => [
                    styles.card,
                    { backgroundColor: palette.surfaceElevated },
                    pressed && { opacity: 0.6 },
                ]}
            >
                <Avatar
                    avatarUrl={item.avatarUrl}
                    displayName={item.displayName}
                    seedId={item.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    {/* Name line: display name (flexes) + a right-aligned
                        coarse timestamp, shown only when there's activity. */}
                    <View style={styles.nameLine}>
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                styles.nameText,
                                { color: palette.text },
                            ]}
                            numberOfLines={1}
                        >
                            {item.displayName}
                        </Text>
                        {item.activity ? (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {relativeActivity(item.activity.activityAt)}
                            </Text>
                        ) : null}
                    </View>
                    {/* Second line: the activity line when it exists, else the
                        @handle fallback. Never an empty line. */}
                    <Text
                        style={[typography.caption, { color: palette.textMuted }]}
                        numberOfLines={1}
                    >
                        {item.activity
                            ? formatActivityLine(item.activity)
                            : `@${item.handle}`}
                    </Text>
                </View>
                {/* No inline per-row actions — requesting a rec lives on
                    the friend's profile (one tap away), keeping rows to
                    identity + navigation. */}
                <ChevronRight
                    color={palette.textMuted}
                    size={20}
                    strokeWidth={ICON_STROKE_WIDTH}
                />
            </Pressable>
        );
    }

    const showEmptyState =
        !loading && !error && friends.length === 0 && pendingIncoming === 0;

    // Case-insensitive match against display name AND @handle (the
    // haystack includes the "@" so typing it or omitting it both work).
    const normalizedQuery = localQuery.trim().toLowerCase();
    const filteredFriends =
        normalizedQuery.length === 0
            ? friends
            : friends.filter((f) =>
                  `${f.displayName} @${f.handle}`
                      .toLowerCase()
                      .includes(normalizedQuery),
              );

    // Sort the filtered set by the active option. Cheap for friend-list sizes,
    // so no memo. "Recently added" mirrors the loader's created_at DESC order.
    const sortedFriends = filteredFriends.slice().sort((a, b) => {
        switch (sortBy) {
            case 'name':
                return a.displayName.localeCompare(b.displayName, undefined, {
                    sensitivity: 'base',
                });
            case 'recentActivity': {
                // Most recent activity first. Friends with no activity sink to
                // the bottom, alphabetical among themselves.
                const aAt = a.activity?.activityAt ?? null;
                const bAt = b.activity?.activityAt ?? null;
                if (aAt && bAt) {
                    if (aAt > bAt) return -1;
                    if (aAt < bAt) return 1;
                    return a.displayName.localeCompare(b.displayName, undefined, {
                        sensitivity: 'base',
                    });
                }
                if (aAt) return -1; // a has activity, b doesn't
                if (bAt) return 1; // b has activity, a doesn't
                return a.displayName.localeCompare(b.displayName, undefined, {
                    sensitivity: 'base',
                });
            }
            case 'recentlyAdded':
            default:
                // Newest friendship first (created_at DESC).
                return a.friendshipCreatedAt < b.friendshipCreatedAt
                    ? 1
                    : a.friendshipCreatedAt > b.friendshipCreatedAt
                      ? -1
                      : 0;
        }
    });

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader
                title="Friends"
                unreadCount={unreadCount}
                // Header-right "+" replaces the previous floating
                // "Add friend" pill (the floating tab bar now occupies
                // the bottom-edge zone; two floating overlays in the
                // same space were visually noisy). Routes to the same
                // /friends/add destination the pill used. The inline
                // "Add friend by handle" link in the empty state
                // (renderEmptyState) covers the no-friends path.
                rightActions={
                    <Pressable
                        onPress={() => router.push('/friends/add')}
                        hitSlop={spacing.sm}
                        accessibilityRole="button"
                        accessibilityLabel="Add friend by handle"
                        style={({ pressed }) => [
                            styles.addAction,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.8 : 1,
                            },
                        ]}
                    >
                        <Plus
                            color={palette.textInverse}
                            size={20}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Add
                        </Text>
                    </Pressable>
                }
            />

            {showLoader ? (
                <FullScreenLoader />
            ) : error ? (
                <View style={styles.fillCenter}>
                    <Text style={[typography.body, { color: palette.error }]}>
                        {error}
                    </Text>
                </View>
            ) : showEmptyState ? (
                <View style={styles.emptyState}>
                    <View style={styles.emptyHeadline}>
                        <Text
                            style={[
                                typography.display,
                                styles.emptyLine,
                                { color: palette.text },
                            ]}
                        >
                            Seen is better with friends
                        </Text>
                        <Text
                            style={[
                                typography.body,
                                styles.emptyLine,
                                { color: palette.textMuted },
                            ]}
                        >
                            Invite yours to get started.
                        </Text>
                    </View>
                    <View style={styles.emptyButtons}>
                        <Pressable
                            onPress={() => void shareInvite()}
                            accessibilityRole="button"
                            accessibilityLabel="Invite friends"
                            style={({ pressed }) => [
                                styles.primaryButton,
                                {
                                    backgroundColor: palette.accent,
                                    opacity: pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.textInverse },
                                ]}
                            >
                                Invite friends
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => router.push('/friends/add')}
                            accessibilityRole="button"
                            accessibilityLabel="Add by handle"
                            style={({ pressed }) => [
                                styles.secondaryButton,
                                {
                                    borderColor: palette.accent,
                                    opacity: pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.accent },
                                ]}
                            >
                                Add by handle
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ) : (
                <>
                    {pendingIncoming > 0 && (
                        <Pressable
                            onPress={() => router.push('/friends/requests')}
                            style={({ pressed }) => [
                                styles.pendingBanner,
                                {
                                    backgroundColor: palette.accentSubtle,
                                    opacity: pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text style={[typography.body, { color: palette.text }]}>
                                {pendingIncoming === 1
                                    ? '1 pending request'
                                    : `${pendingIncoming} pending requests`}
                            </Text>
                            <ChevronRight
                                color={palette.textMuted}
                                size={20}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    )}

                    {friends.length > 0 ? (
                        <>
                            {/* Local name/handle filter. Mirrors the
                                library + friend-library local-search:
                                borderless surface pill, inline clear-X
                                (clear-but-stay), and a Cancel sibling
                                that appears on focus (blur + clear). */}
                            <View style={styles.searchRow}>
                                <View
                                    style={[
                                        styles.searchBar,
                                        { backgroundColor: palette.surface },
                                    ]}
                                >
                                    <SearchIcon
                                        color={palette.textMuted}
                                        size={20}
                                        strokeWidth={ICON_STROKE_WIDTH}
                                    />
                                    <TextInput
                                        ref={localSearchInputRef}
                                        value={localQuery}
                                        onChangeText={setLocalQuery}
                                        placeholder="Search friends"
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
                                    {localQuery.length > 0 ? (
                                        <Pressable
                                            onPress={() => setLocalQuery('')}
                                            hitSlop={spacing.sm}
                                            accessibilityRole="button"
                                            accessibilityLabel="Clear search"
                                            style={({ pressed }) => [
                                                pressed && { opacity: 0.6 },
                                            ]}
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
                                            setLocalQuery('');
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
                                        <Text
                                            style={[
                                                typography.body,
                                                { color: palette.accent },
                                            ]}
                                        >
                                            Cancel
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </View>

                            {/* Sort chips — three feasible options. Active
                                chip is accent-filled; the rest read as muted
                                outlines. */}
                            <View style={styles.sortRow}>
                                {FRIEND_SORTS.map((opt) => (
                                    <Chip
                                        key={opt.value}
                                        label={opt.label}
                                        active={sortBy === opt.value}
                                        onPress={() => setSortBy(opt.value)}
                                        accessibilityLabel={`Sort by ${opt.label}`}
                                    />
                                ))}
                            </View>

                            {sortedFriends.length > 0 ? (
                                <FlatList
                                    data={sortedFriends}
                                    keyExtractor={(item) => item.userId}
                                    renderItem={renderFriendRow}
                                    keyboardShouldPersistTaps="handled"
                                    keyboardDismissMode="on-drag"
                                    contentContainerStyle={[
                                        styles.listContent,
                                        { paddingBottom: tabBarInset },
                                    ]}
                                    ItemSeparatorComponent={() => (
                                        <View style={styles.cardGap} />
                                    )}
                                />
                            ) : (
                                <View style={styles.fillCenter}>
                                    <Text
                                        style={[
                                            typography.body,
                                            { color: palette.textMuted },
                                        ]}
                                    >
                                        No friends found.
                                    </Text>
                                </View>
                            )}
                        </>
                    ) : (
                        <View style={styles.fillCenter}>
                            <Text style={[typography.body, { color: palette.textMuted }]}>
                                No friends yet — check pending requests or add
                                someone by their handle.
                            </Text>
                        </View>
                    )}
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    addAction: {
        // Header-right "+ Add" — a compact filled plum pill (fill inline),
        // matching the chat/recommend header Send buttons: the shared
        // button radius at header scale, white icon + label. Vertical
        // padding is 7 (NOT spacing.sm/8): 22pt line + 14 = exactly the
        // header bar's pinned 36pt content region, preserving the
        // "bell at the same Y on every tab" invariant (see the bar height
        // comment in screen-header.tsx). Routes to /friends/add.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingVertical: 7,
        paddingHorizontal: spacing.base,
        borderRadius: button.borderRadius,
    },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    sortRow: {
        // Sort chips under the search pill. marginHorizontal matches the
        // searchRow so the chips align with the pill's left edge. Inter-chip
        // gap matches the Library filter row (spacing.xs) now that both use
        // the shared <Chip>.
        flexDirection: 'row',
        gap: spacing.xs,
        marginHorizontal: spacing.base,
        marginBottom: spacing.md,
    },
    searchRow: {
        // Outer row hosting the search pill + the conditional Cancel
        // sibling. Margins live here (not on the pill) so the pill can
        // flex to fill width when Cancel appears/disappears. Mirrors the
        // friend-library searchRow exactly.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
        marginBottom: spacing.md,
    },
    searchBar: {
        // Borderless surface pill — the surface fill against the page bg
        // is the separation (no border, matching library/friend-library
        // local search). flex: 1 so it shrinks when Cancel appears.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.full,
        height: 44,
    },
    cancelButton: {
        // Plain text Pressable, sized via horizontal padding. Mirrors
        // the other local-search Cancel buttons.
        paddingHorizontal: spacing.xs,
    },
    searchInput: {
        flex: 1,
        // padding zeroed: the parent's fixed height owns vertical sizing
        // so the icon and text stay aligned.
        paddingVertical: 0,
    },
    pendingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginHorizontal: spacing.base,
        marginTop: spacing.sm,
        marginBottom: spacing.md,
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        // paddingBottom set inline at the FlatList via
        // useFloatingTabBarInset — replaces the previous
        // FLOATING_BUTTON_CLEAR clearance for the now-removed
        // floating "Add friend" pill. The Add-friend affordance
        // moved to a header-right "+" button (see the ScreenHeader
        // rightActions prop above).
    },
    // Friend row as a card — matches the title page's recommended-by /
    // watched-by social cards: surfaceElevated fill (inline, palette-driven),
    // radius.md, padding md, fill-only (no shadow). Discrete cards separated
    // by gaps (cardGap via ItemSeparator), not dividers.
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.md,
        borderRadius: radius.md,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    // Name + right-aligned timestamp on one line. The name flexes and
    // truncates; the timestamp keeps its intrinsic width at the right edge.
    nameLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    nameText: {
        flexShrink: 1,
    },
    // Air between cards (spacing.md = 12) so they read as discrete objects,
    // not a striped block — especially at radius.md.
    cardGap: {
        height: spacing.md,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        // Optical centering: bias the group up off the geometric center (which
        // reads low, partly under the floating tab bar) with a modest bottom
        // offset. No app-wide optical-center pattern to match — other empty
        // states use plain geometric center.
        paddingBottom: spacing.xxxl,
        // Larger gap (xl) between the copy block and the buttons than between
        // the two text lines (which stack tight on lineHeight) — so heading +
        // subline read as one group, separate from the buttons.
        gap: spacing.xl,
    },
    // Heading (line 1, display) + subline (line 2, body/muted), stacked tight —
    // no gap here; lineHeight gives the small heading↔subline spacing.
    emptyHeadline: {
        alignItems: 'center',
        // A little breathing room between the heading and its subline (still
        // well under the xl copy↔buttons gap, so the grouping holds).
        gap: spacing.sm,
    },
    emptyLine: {
        textAlign: 'center',
    },
    emptyButtons: {
        // Primary (Invite friends) on top, secondary (Add by handle) below —
        // both full-width within the centered empty state, standard gap.
        alignSelf: 'stretch',
        gap: spacing.sm,
    },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    secondaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
