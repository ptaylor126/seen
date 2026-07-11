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

interface FriendRow {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    // friendships.created_at — for the "Recently added" sort.
    friendshipCreatedAt: string;
    // Count of recommendations exchanged with this friend, both directions.
    recCount: number;
}

type FriendSort = 'recentlyAdded' | 'name' | 'mostRecs';

const FRIEND_SORTS: { value: FriendSort; label: string }[] = [
    { value: 'recentlyAdded', label: 'Recently added' },
    { value: 'name', label: 'Name (A–Z)' },
    { value: 'mostRecs', label: 'Most recs' },
];

const AVATAR_SIZE = 44;

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
            const [friendshipsResult, pendingResult, recsResult] =
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
                    // Recs involving me (either direction), for the "Most recs"
                    // sort. Minimal columns, counted per friend client-side
                    // below. RLS (recommendations_select_party) scopes this to
                    // rows where I'm sender or recipient.
                    supabase
                        .from('recommendations')
                        .select('from_user_id, to_user_id')
                        .or(
                            `from_user_id.eq.${userId},to_user_id.eq.${userId}`,
                        ),
                ]);
            if (friendshipsResult.error) throw friendshipsResult.error;
            if (pendingResult.error) throw pendingResult.error;
            if (recsResult.error) throw recsResult.error;

            setPendingIncoming(pendingResult.count ?? 0);

            const rows = friendshipsResult.data ?? [];
            const createdAtById = new Map<string, string>();
            const otherIds = rows.map((r) => {
                const other =
                    r.user_a_id === userId ? r.user_b_id : r.user_a_id;
                createdAtById.set(other, r.created_at);
                return other;
            });

            // Count recs per friend (both directions). from_user_id can be null
            // (sender deleted — FK ON DELETE SET NULL); those can't be
            // attributed to a friend, so skip them.
            const recCountById = new Map<string, number>();
            for (const rec of recsResult.data ?? []) {
                const other =
                    rec.from_user_id === userId
                        ? rec.to_user_id
                        : rec.from_user_id;
                if (!other) continue;
                recCountById.set(other, (recCountById.get(other) ?? 0) + 1);
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
                    recCount: recCountById.get(p.id) ?? 0,
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
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                <Avatar
                    avatarUrl={item.avatarUrl}
                    displayName={item.displayName}
                    seedId={item.userId}
                    size={AVATAR_SIZE}
                />
                <View style={styles.rowText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {item.displayName}
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        @{item.handle}
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
            case 'mostRecs':
                // Most first; tie-break by name for a stable, sensible order.
                return (
                    b.recCount - a.recCount ||
                    a.displayName.localeCompare(b.displayName, undefined, {
                        sensitivity: 'base',
                    })
                );
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
                                        <View
                                            style={[
                                                styles.separator,
                                                { backgroundColor: palette.border },
                                            ]}
                                        />
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
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    rowText: {
        flex: 1,
        gap: spacing.xs,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: AVATAR_SIZE + spacing.md,
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
