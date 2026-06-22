import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { maybeEnablePushAfterAccept } from '@/lib/push';
import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface RequestRow {
    requestId: string;
    otherId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

const AVATAR_SIZE = 40;

export default function FriendRequestsScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [incoming, setIncoming] = useState<RequestRow[]>([]);
    const [outgoing, setOutgoing] = useState<RequestRow[]>([]);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const [incomingResult, outgoingResult] = await Promise.all([
                supabase
                    .from('friend_requests')
                    .select('id, from_user_id, created_at')
                    .eq('to_user_id', userId)
                    .order('created_at', { ascending: false }),
                supabase
                    .from('friend_requests')
                    .select('id, to_user_id, created_at')
                    .eq('from_user_id', userId)
                    .order('created_at', { ascending: false }),
            ]);
            if (incomingResult.error) throw incomingResult.error;
            if (outgoingResult.error) throw outgoingResult.error;

            const incomingRows = incomingResult.data ?? [];
            const outgoingRows = outgoingResult.data ?? [];

            const otherIds = Array.from(
                new Set<string>([
                    ...incomingRows.map((r) => r.from_user_id),
                    ...outgoingRows.map((r) => r.to_user_id),
                ]),
            );

            const profilesById = new Map<
                string,
                { handle: string; display_name: string; avatar_url: string | null }
            >();
            if (otherIds.length > 0) {
                const { data: profiles, error: profilesError } = await supabase
                    .from('profiles')
                    .select('id, handle, display_name, avatar_url')
                    .in('id', otherIds);
                if (profilesError) throw profilesError;
                for (const p of profiles ?? []) {
                    profilesById.set(p.id, {
                        handle: p.handle,
                        display_name: p.display_name,
                        avatar_url: p.avatar_url,
                    });
                }
            }

            const mapRow = (
                requestId: string,
                otherId: string,
            ): RequestRow => {
                const p = profilesById.get(otherId);
                return {
                    requestId,
                    otherId,
                    handle: p?.handle ?? 'unknown',
                    displayName: p?.display_name ?? 'Unknown user',
                    avatarUrl: p?.avatar_url ?? null,
                };
            };

            setIncoming(
                incomingRows.map((r) => mapRow(r.id, r.from_user_id)),
            );
            setOutgoing(
                outgoingRows.map((r) => mapRow(r.id, r.to_user_id)),
            );
        } catch (err) {
            console.error('friend requests fetch failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to load requests');
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            load();
        }, [load]),
    );

    async function handleAccept(requestId: string) {
        if (actionBusy) return;
        setActionBusy(requestId);
        try {
            const { error: rpcError } = await supabase.rpc('accept_friend_request', {
                request_id: requestId,
            });
            if (rpcError) throw rpcError;
            // Remove from the local list optimistically.
            setIncoming((prev) => prev.filter((r) => r.requestId !== requestId));

            // Social-commitment moment: this is where it's natural to ask
            // for push permissions. Helper is silent on every error so a
            // permission hiccup can't surface as an Accept failure.
            const {
                data: { session },
            } = await supabase.auth.getSession();
            if (session?.user.id) {
                await maybeEnablePushAfterAccept(session.user.id);
            }
        } catch (err) {
            console.error('accept failed:', err);
            surfaceError(err, "Couldn't accept");
        } finally {
            setActionBusy(null);
        }
    }

    async function handleDecline(requestId: string) {
        if (actionBusy) return;
        setActionBusy(requestId);
        try {
            const { error: rpcError } = await supabase.rpc('decline_friend_request', {
                request_id: requestId,
            });
            if (rpcError) throw rpcError;
            setIncoming((prev) => prev.filter((r) => r.requestId !== requestId));
        } catch (err) {
            console.error('decline failed:', err);
            surfaceError(err, "Couldn't decline");
        } finally {
            setActionBusy(null);
        }
    }

    async function handleCancel(requestId: string) {
        if (actionBusy) return;
        setActionBusy(requestId);
        try {
            const { error: deleteError } = await supabase
                .from('friend_requests')
                .delete()
                .eq('id', requestId);
            if (deleteError) throw deleteError;
            setOutgoing((prev) => prev.filter((r) => r.requestId !== requestId));
        } catch (err) {
            console.error('cancel failed:', err);
            surfaceError(err, "Couldn't cancel");
        } finally {
            setActionBusy(null);
        }
    }

    function renderAvatar(row: RequestRow) {
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

    function renderRow(row: RequestRow, kind: 'incoming' | 'outgoing') {
        const busy = actionBusy === row.requestId;
        return (
            <View key={row.requestId} style={styles.row}>
                {renderAvatar(row)}
                <View style={styles.rowText}>
                    <Text
                        style={[typography.bodyEmphasis, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {row.displayName}
                    </Text>
                    <Text style={[typography.caption, { color: palette.textMuted }]}>
                        @{row.handle}
                    </Text>
                </View>
                <View style={styles.rowActions}>
                    {kind === 'incoming' ? (
                        <>
                            <Pressable
                                onPress={() => handleAccept(row.requestId)}
                                disabled={busy}
                                style={({ pressed }) => [
                                    styles.acceptButton,
                                    {
                                        backgroundColor: palette.accent,
                                        opacity: pressed || busy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textInverse, fontWeight: '600' },
                                    ]}
                                >
                                    Accept
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={() => handleDecline(row.requestId)}
                                disabled={busy}
                                style={({ pressed }) => [
                                    styles.declineButton,
                                    {
                                        borderColor: palette.border,
                                        opacity: pressed || busy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted, fontWeight: '600' },
                                    ]}
                                >
                                    Decline
                                </Text>
                            </Pressable>
                        </>
                    ) : (
                        <Pressable
                            onPress={() => handleCancel(row.requestId)}
                            disabled={busy}
                            style={({ pressed }) => [
                                styles.declineButton,
                                {
                                    borderColor: palette.border,
                                    opacity: pressed || busy ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted, fontWeight: '600' },
                                ]}
                            >
                                Cancel
                            </Text>
                        </Pressable>
                    )}
                </View>
            </View>
        );
    }

    const empty = !loading && !error && incoming.length === 0 && outgoing.length === 0;

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
                    Friend requests
                </Text>
            </View>

            {showLoader ? (
                <FullScreenLoader />
            ) : error ? (
                <View style={styles.fillCenter}>
                    <Text style={[typography.body, { color: palette.error }]}>
                        {error}
                    </Text>
                </View>
            ) : empty ? (
                <View style={styles.fillCenter}>
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        No pending requests
                    </Text>
                </View>
            ) : (
                <ScrollView contentContainerStyle={styles.scrollContent}>
                    {incoming.length > 0 && (
                        <View style={styles.section}>
                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionLabel,
                                    { color: palette.textMuted },
                                ]}
                            >
                                INCOMING
                            </Text>
                            {incoming.map((r) => renderRow(r, 'incoming'))}
                        </View>
                    )}
                    {outgoing.length > 0 && (
                        <View style={styles.section}>
                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionLabel,
                                    { color: palette.textMuted },
                                ]}
                            >
                                OUTGOING
                            </Text>
                            {outgoing.map((r) => renderRow(r, 'outgoing'))}
                        </View>
                    )}
                </ScrollView>
            )}
        </SafeAreaView>
    );
}

function surfaceError(err: unknown, title: string) {
    if (err && typeof err === 'object' && 'message' in err) {
        const supaErr = err as {
            message: string;
            details?: string;
            hint?: string;
            code?: string;
        };
        Alert.alert(
            title,
            `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
        );
    } else {
        Alert.alert(title, String(err));
    }
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
    fillCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    scrollContent: { paddingBottom: spacing.xl },
    section: {
        marginTop: spacing.lg,
    },
    sectionLabel: {
        paddingHorizontal: spacing.base,
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
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
    rowActions: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    acceptButton: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
    },
    declineButton: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
});
