import { useFocusEffect, useRouter } from 'expo-router';
import {
    ChevronRight,
    MessageSquarePlus,
    Plus,
    Search as SearchIcon,
    Users,
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
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import { RequestRecSheet } from '@/components/request-rec-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { useRequestRec } from '@/hooks/use-request-rec';
import { useUnreadCount } from '@/hooks/use-unread-count';
import supabase from '@/lib/supabase';
import {
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
}

const AVATAR_SIZE = 44;

export default function FriendsScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const requestRec = useRequestRec();
    const tabBarInset = useFloatingTabBarInset();
    const { count: unreadCount } = useUnreadCount();

    const [friends, setFriends] = useState<FriendRow[]>([]);
    const [pendingIncoming, setPendingIncoming] = useState(0);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);

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
            const [friendshipsResult, pendingResult] = await Promise.all([
                supabase
                    .from('friendships')
                    .select('user_a_id, user_b_id, created_at')
                    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
                    .order('created_at', { ascending: false }),
                supabase
                    .from('friend_requests')
                    .select('id', { count: 'exact', head: true })
                    .eq('to_user_id', userId),
            ]);
            if (friendshipsResult.error) throw friendshipsResult.error;
            if (pendingResult.error) throw pendingResult.error;

            setPendingIncoming(pendingResult.count ?? 0);

            const rows = friendshipsResult.data ?? [];
            const otherIds = rows.map((r) =>
                r.user_a_id === userId ? r.user_b_id : r.user_a_id,
            );

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
                {/* Inline request action. Its own Pressable captures the
                    tap so the surrounding row-to-profile navigation
                    doesn't also fire. */}
                <Pressable
                    onPress={() =>
                        requestRec.open(item.userId, item.displayName)
                    }
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Request a recommendation from ${item.displayName}`}
                    style={({ pressed }) => [
                        styles.requestIconButton,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <MessageSquarePlus
                        color={palette.textMuted}
                        size={20}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
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
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Plus
                            color={palette.accent}
                            size={20}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
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
                    <Users
                        color={palette.textMuted}
                        size={64}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                    <Text
                        style={[
                            typography.heading,
                            styles.emptyHeading,
                            { color: palette.text },
                        ]}
                    >
                        Seen is better with friends. Add yours to get started.
                    </Text>
                    <Text
                        style={[
                            typography.body,
                            styles.emptyBody,
                            { color: palette.textMuted },
                        ]}
                    >
                        Add someone by their handle.
                    </Text>
                    <View style={styles.emptyActions}>
                        <Pressable
                            onPress={() => router.push('/friends/add')}
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

                            {filteredFriends.length > 0 ? (
                                <FlatList
                                    data={filteredFriends}
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
    requestIconButton: {
        // Inline per-row "request a rec" affordance, sat between the
        // name block and the chevron. Padding gives a comfortable tap
        // target without enlarging the row.
        paddingHorizontal: spacing.xs,
        paddingVertical: spacing.xs,
    },
    addAction: {
        // Header-right "+ Add" — icon + label so it reads as a clear
        // action rather than a bare ambiguous "+". Accent-coloured to
        // mark it as the primary affordance (matches the accent "Add by
        // handle" / Cancel text used elsewhere). Routes to /friends/add.
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
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
        gap: spacing.base,
    },
    emptyHeading: {
        textAlign: 'center',
        marginTop: spacing.lg,
    },
    emptyBody: {
        textAlign: 'center',
        marginBottom: spacing.lg,
    },
    emptyActions: {
        alignSelf: 'stretch',
        gap: spacing.sm,
    },
    secondaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
