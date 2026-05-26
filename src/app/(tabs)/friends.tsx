import { Image } from 'expo-image';
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

    function renderAvatar(row: FriendRow) {
        if (row.avatarUrl) {
            return (
                <Image
                    source={{ uri: row.avatarUrl }}
                    style={[styles.avatar, { backgroundColor: palette.accent }]}
                    contentFit="cover"
                    transition={150}
                />
            );
        }
        const letter = row.displayName[0]?.toUpperCase() ?? '?';
        return (
            <View
                style={[
                    styles.avatar,
                    styles.avatarFallback,
                    { backgroundColor: palette.accent },
                ]}
            >
                <Text
                    style={[typography.bodyEmphasis, { color: palette.textInverse }]}
                >
                    {letter}
                </Text>
            </View>
        );
    }

    function renderFriendRow({ item }: { item: FriendRow }) {
        return (
            <Pressable
                onPress={() => router.push(`/friends/${item.handle}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
                {renderAvatar(item)}
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
                    <View style={styles.actionRow}>
                        <Pressable
                            onPress={() => router.push('/friends/invite')}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <Text style={[typography.body, { color: palette.accent }]}>
                                Invite more
                            </Text>
                        </Pressable>
                    </View>

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
    actionRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
    },
    pendingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginHorizontal: spacing.base,
        marginBottom: spacing.md,
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    listContent: { paddingHorizontal: spacing.base, paddingBottom: spacing.lg },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    avatar: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
    },
    avatarFallback: {
        alignItems: 'center',
        justifyContent: 'center',
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
