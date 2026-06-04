import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Users } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { ScreenHeader } from '@/components/screen-header';
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

// List bottom padding so the last friend isn't hidden behind the
// floating two-button action cluster (Add friend / Invite link). The
// cluster is still a single pill-height row, so the clear distance
// matches a single button: ~46pt + bottom offset (spacing.base) +
// breathing room. The tab bar lives outside the screen view and is
// already cleared by React Navigation.
const FLOATING_BUTTON_CLEAR = spacing.xxxl + spacing.base;

export default function FriendsScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { count: unreadCount } = useUnreadCount();

    const [friends, setFriends] = useState<FriendRow[]>([]);
    const [pendingIncoming, setPendingIncoming] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

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
    const showFloatingActions = !loading && !error && !showEmptyState;

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Friends" unreadCount={unreadCount} />

            {loading ? (
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
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
                        Share your invite link, or add someone by their handle.
                    </Text>
                    <View style={styles.emptyActions}>
                        <Pressable
                            onPress={() => router.push('/friends/invite')}
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
                                Share your invite link
                            </Text>
                        </Pressable>
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
                        <FlatList
                            data={friends}
                            keyExtractor={(item) => item.userId}
                            renderItem={renderFriendRow}
                            contentContainerStyle={styles.listContent}
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
                            <Text style={[typography.body, { color: palette.textMuted }]}>
                                No friends yet — check pending requests or invite
                                someone.
                            </Text>
                        </View>
                    )}
                </>
            )}

            {showFloatingActions && (
                <View style={styles.floatingActions} pointerEvents="box-none">
                    {/* Primary: find someone already on Seen and send a
                        friend request. The request must be accepted by
                        the recipient — not an auto-friendship. */}
                    <Pressable
                        onPress={() => router.push('/friends/add')}
                        style={({ pressed }) => [
                            styles.floatingPrimaryButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Add friend by handle"
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Add friend
                        </Text>
                    </Pressable>
                    {/* Secondary: share an invite link to bring someone
                        new in. Accepting the link auto-friends, so this
                        is the path for people not yet on Seen. */}
                    <Pressable
                        onPress={() => router.push('/friends/invite')}
                        style={({ pressed }) => [
                            styles.floatingSecondaryButton,
                            {
                                borderColor: palette.accent,
                                backgroundColor: palette.bg,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Share invite link"
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
                            ]}
                        >
                            Invite link
                        </Text>
                    </Pressable>
                </View>
            )}
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
        paddingBottom: FLOATING_BUTTON_CLEAR,
    },
    floatingActions: {
        // Same anchoring as the prior single pill — full-width wrapper
        // with `pointerEvents="box-none"` so taps on transparent padding
        // pass through to the list. flexDirection: row + center +
        // gap.md groups the two pills as a single connected affordance.
        position: 'absolute',
        left: spacing.base,
        right: spacing.base,
        bottom: spacing.base,
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.md,
    },
    floatingPrimaryButton: {
        // Same pill shape as the previous single invite button so the
        // anchor visually matches what was there.
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    floatingSecondaryButton: {
        // Outlined pill in the same shape — accent border, cream fill
        // (NOT transparent, so the list scrolling behind doesn't show
        // through the rounded corners). Vertical padding accounts for
        // the 1.5pt border to keep the cluster's heights identical.
        paddingVertical: spacing.md - 1.5,
        paddingHorizontal: spacing.lg - 1.5,
        borderRadius: radius.full,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
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
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    secondaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
