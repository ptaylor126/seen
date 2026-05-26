import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type MediaType = 'movie' | 'tv';

interface FriendRow {
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
}

interface TitleContext {
    title: string;
    posterPath: string | null;
}

const NOTE_MAX_LENGTH = 500;
const FRIEND_AVATAR_SIZE = 44;
const POSTER_W = 40;
const POSTER_H = 60;

export default function RecommendScreen() {
    const params = useLocalSearchParams<{
        mediaType: string;
        tmdbId: string;
        // Pre-selected recipient id, forwarded by /library/add when the
        // user entered the recommend flow from a friend profile.
        preselect?: string;
    }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);
    const preselectedFriendId =
        typeof params.preselect === 'string' && params.preselect.length > 0
            ? params.preselect
            : null;

    const [titleCtx, setTitleCtx] = useState<TitleContext | null>(null);
    const [friends, setFriends] = useState<FriendRow[]>([]);
    // Initial state seeds from the preselect param so the recipient is
    // pre-checked when arriving from the friend-profile recommend flow.
    // We never re-apply it after mount — once the user picks, they own
    // the selection.
    const [selectedFriendId, setSelectedFriendId] = useState<string | null>(
        preselectedFriendId,
    );
    const [note, setNote] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (!mediaType || !Number.isFinite(tmdbId)) {
            setError('Invalid title');
            setLoading(false);
            return;
        }
        let active = true;

        const titlePromise: Promise<TitleContext> =
            mediaType === 'movie'
                ? getMovie(tmdbId).then((m: TMDBMovie) => ({
                      title: m.title,
                      posterPath: m.poster_path,
                  }))
                : getTV(tmdbId).then((t: TMDBTV) => ({
                      title: t.name,
                      posterPath: t.poster_path,
                  }));

        (async () => {
            try {
                const [resolvedTitle, sessionResult] = await Promise.all([
                    titlePromise,
                    supabase.auth.getSession(),
                ]);
                if (!active) return;
                setTitleCtx(resolvedTitle);

                const userId = sessionResult.data.session?.user.id;
                if (!userId) throw new Error('Not authenticated');

                // Same lexicographic OR-match used by the friends tab; we
                // pick the other party per row and batch the profile
                // lookups by id.
                const { data: friendships, error: friendshipsError } = await supabase
                    .from('friendships')
                    .select('user_a_id, user_b_id')
                    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`);
                if (friendshipsError) throw friendshipsError;
                if (!active) return;

                const otherIds = (friendships ?? []).map((f) =>
                    f.user_a_id === userId ? f.user_b_id : f.user_a_id,
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
                if (!active) return;

                setFriends(
                    (profiles ?? []).map((p) => ({
                        userId: p.id,
                        handle: p.handle,
                        displayName: p.display_name,
                        avatarUrl: p.avatar_url,
                    })),
                );
            } catch (err) {
                if (!active) return;
                console.error('recommend init failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId]);

    const trimmedNote = note.trim();
    const canSend =
        !sending && selectedFriendId !== null && mediaType !== null && !loading;

    async function handleSend() {
        if (!canSend || !mediaType || !selectedFriendId) return;
        setSending(true);
        try {
            const { error: rpcError } = await supabase.rpc('send_recommendation', {
                to_user_id: selectedFriendId,
                tmdb_id: tmdbId,
                media_type: mediaType,
                note: trimmedNote.length > 0 ? trimmedNote : undefined,
            });
            if (rpcError) throw rpcError;

            Alert.alert('Sent', 'Recommendation sent.', [
                { text: 'OK', onPress: () => router.back() },
            ]);
        } catch (err) {
            console.error('send recommendation failed:', err);
            surfaceError(err, "Couldn't send");
        } finally {
            setSending(false);
        }
    }

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

    function renderFriendRow(row: FriendRow) {
        const isSelected = row.userId === selectedFriendId;
        return (
            <Pressable
                key={row.userId}
                onPress={() =>
                    setSelectedFriendId(isSelected ? null : row.userId)
                }
                style={({ pressed }) => [
                    styles.friendRow,
                    isSelected && { backgroundColor: palette.accentSubtle },
                    pressed && { opacity: 0.6 },
                ]}
            >
                {renderAvatar(row)}
                <View style={styles.friendText}>
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
                <View
                    style={[
                        styles.checkCircle,
                        {
                            borderColor: isSelected ? palette.accent : palette.border,
                            backgroundColor: isSelected
                                ? palette.accent
                                : 'transparent',
                        },
                    ]}
                >
                    {isSelected && (
                        <Check
                            color={palette.textInverse}
                            size={16}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    )}
                </View>
            </Pressable>
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
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Cancel
                    </Text>
                </Pressable>
                <Text style={[typography.heading, { color: palette.text }]}>
                    Recommend
                </Text>
                <Pressable
                    onPress={handleSend}
                    disabled={!canSend}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        pressed && { opacity: 0.6 },
                        !canSend && { opacity: 0.4 },
                    ]}
                >
                    {sending ? (
                        <ActivityIndicator color={palette.accent} />
                    ) : (
                        <Text style={[typography.bodyEmphasis, { color: palette.accent }]}>
                            Send
                        </Text>
                    )}
                </Pressable>
            </View>

            <KeyboardAvoidingView
                style={styles.flex}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={0}
            >
                <ScrollView
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.scrollContent}
                >
                    {/* Title context — keeps the modal grounded in what's
                        being recommended without needing to scroll back. */}
                    {titleCtx && (
                        <View style={styles.titleContext}>
                            {titleCtx.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(titleCtx.posterPath, 'w185'),
                                    }}
                                    style={styles.contextPoster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.contextPoster,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    styles.contextTitle,
                                    { color: palette.text },
                                ]}
                                numberOfLines={2}
                            >
                                {titleCtx.title}
                            </Text>
                        </View>
                    )}

                    {loading ? (
                        <View style={styles.statusBlock}>
                            <ActivityIndicator color={palette.accent} />
                        </View>
                    ) : error ? (
                        <View style={styles.statusBlock}>
                            <Text style={[typography.body, { color: palette.error }]}>
                                {error}
                            </Text>
                        </View>
                    ) : friends.length === 0 ? (
                        <View style={styles.statusBlock}>
                            <Text
                                style={[typography.body, { color: palette.textMuted }]}
                                numberOfLines={3}
                            >
                                You don&apos;t have any friends yet. Add one before sending
                                recs.
                            </Text>
                        </View>
                    ) : (
                        <>
                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionLabel,
                                    { color: palette.textMuted },
                                ]}
                            >
                                SEND TO
                            </Text>
                            <View style={styles.friendList}>
                                {friends.map(renderFriendRow)}
                            </View>

                            <Text
                                style={[
                                    typography.micro,
                                    styles.sectionLabel,
                                    { color: palette.textMuted },
                                ]}
                            >
                                ADD A NOTE (OPTIONAL)
                            </Text>
                            <View
                                style={[
                                    styles.noteBox,
                                    {
                                        backgroundColor: palette.surface,
                                        borderColor: palette.border,
                                    },
                                ]}
                            >
                                <TextInput
                                    value={note}
                                    onChangeText={(v) =>
                                        setNote(v.slice(0, NOTE_MAX_LENGTH))
                                    }
                                    placeholder="What did you love about it?"
                                    placeholderTextColor={palette.textMuted}
                                    multiline
                                    maxLength={NOTE_MAX_LENGTH}
                                    editable={!sending}
                                    style={[
                                        styles.noteInput,
                                        typography.body,
                                        { color: palette.text },
                                    ]}
                                />
                            </View>
                            <Text
                                style={[
                                    typography.caption,
                                    styles.charCount,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {note.length}/{NOTE_MAX_LENGTH}
                            </Text>
                        </>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
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
    flex: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
    scrollContent: {
        paddingBottom: spacing.xl,
    },
    titleContext: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
    },
    contextPoster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    contextTitle: {
        flex: 1,
    },
    statusBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xxl,
        paddingHorizontal: spacing.xl,
    },
    sectionLabel: {
        paddingHorizontal: spacing.base,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    friendList: {
        paddingHorizontal: spacing.base,
    },
    friendRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        gap: spacing.md,
    },
    avatar: {
        width: FRIEND_AVATAR_SIZE,
        height: FRIEND_AVATAR_SIZE,
        borderRadius: FRIEND_AVATAR_SIZE / 2,
    },
    avatarFallback: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    friendText: {
        flex: 1,
        gap: spacing.xs,
    },
    checkCircle: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    noteBox: {
        marginHorizontal: spacing.base,
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        minHeight: 100,
    },
    noteInput: {
        minHeight: 80,
        textAlignVertical: 'top',
    },
    charCount: {
        textAlign: 'right',
        paddingHorizontal: spacing.base,
        marginTop: spacing.xs,
    },
});
