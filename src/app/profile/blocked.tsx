import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface BlockedUser {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

export default function BlockedUsersScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    // null = still loading; [] = loaded, none blocked.
    const [rows, setRows] = useState<BlockedUser[] | null>(null);
    const showLoader = useDeferredLoading(rows === null);
    const [error, setError] = useState(false);
    // user_id currently being unblocked — guards against double-tap and dims
    // that row while the RPC is in flight.
    const [unblockingId, setUnblockingId] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            // The blocker can't read blocked users' profiles directly (the
            // profiles policy hides them symmetrically), so we go through the
            // SECURITY DEFINER list_blocked_users() RPC.
            const { data, error: rpcError } =
                await supabase.rpc('list_blocked_users');
            if (!active) return;
            if (rpcError) {
                console.error('list blocked users failed:', rpcError);
                setError(true);
                setRows([]);
                return;
            }
            setRows(
                (data ?? []).map((r) => ({
                    userId: r.user_id,
                    handle: r.handle,
                    displayName: r.display_name,
                    avatarUrl: r.avatar_url,
                })),
            );
        })();
        return () => {
            active = false;
        };
    }, []);

    async function performUnblock(user: BlockedUser) {
        if (unblockingId) return;
        setUnblockingId(user.userId);
        try {
            const { error: rpcError } = await supabase.rpc('unblock_user', {
                other_user_id: user.userId,
            });
            if (rpcError) throw rpcError;
            // Drop the row locally on success (no refetch needed).
            setRows((prev) =>
                prev ? prev.filter((r) => r.userId !== user.userId) : prev,
            );
            setUnblockingId(null);
        } catch (err) {
            console.error('unblock user failed:', err);
            setUnblockingId(null);
            Alert.alert('Could not unblock', 'Please try again.');
        }
    }

    function confirmUnblock(user: BlockedUser) {
        if (unblockingId) return;
        Alert.alert(
            `Unblock ${user.displayName}?`,
            'They will be able to see your profile and recommendations again. This does not re-add them as a friend.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Unblock',
                    onPress: () => void performUnblock(user),
                },
            ],
        );
    }

    function renderRow({ item }: { item: BlockedUser }) {
        const busy = unblockingId === item.userId;
        return (
            <View style={styles.row}>
                <Avatar
                    avatarUrl={item.avatarUrl}
                    displayName={item.displayName}
                    seedId={item.userId}
                    size={40}
                />
                <View style={styles.rowText}>
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
                <Pressable
                    onPress={() => confirmUnblock(item)}
                    disabled={busy}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Unblock ${item.displayName}`}
                    style={({ pressed }) => [
                        styles.unblockButton,
                        { borderColor: palette.border },
                        (pressed || busy) && { opacity: 0.5 },
                    ]}
                >
                    {busy ? (
                        <ActivityIndicator color={palette.accent} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
                            ]}
                        >
                            Unblock
                        </Text>
                    )}
                </Pressable>
            </View>
        );
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <View style={styles.header}>
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
                <Text style={[typography.heading, { color: palette.text }]}>
                    Blocked users
                </Text>
            </View>

            {showLoader ? (
                <FullScreenLoader />
            ) : error ? (
                <View style={styles.center}>
                    <Text
                        style={[
                            typography.body,
                            styles.emptyText,
                            { color: palette.textMuted },
                        ]}
                    >
                        Couldn&apos;t load your blocked users. Please try again.
                    </Text>
                </View>
            ) : !rows || rows.length === 0 ? (
                <View style={styles.center}>
                    <Text
                        style={[
                            typography.body,
                            styles.emptyText,
                            { color: palette.textMuted },
                        ]}
                    >
                        You haven&apos;t blocked anyone.
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={rows}
                    keyExtractor={(item) => item.userId}
                    renderItem={renderRow}
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
            )}
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    emptyText: { textAlign: 'center' },
    listContent: {
        paddingHorizontal: spacing.base,
        paddingTop: spacing.sm,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
    },
    rowText: { flex: 1, gap: 2 },
    unblockButton: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.full,
        borderWidth: 1.5,
        minWidth: 92,
        alignItems: 'center',
        justifyContent: 'center',
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: 40 + spacing.md, // align under the text, past the avatar
    },
});
