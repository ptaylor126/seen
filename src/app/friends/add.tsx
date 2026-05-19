import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import supabase from '@/lib/supabase';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

const MIN_HANDLE_LENGTH = 3;

export default function AddFriendScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [handle, setHandle] = useState('');
    const [busy, setBusy] = useState(false);
    const [myHandle, setMyHandle] = useState<string | null>(null);

    const trimmed = handle.trim().toLowerCase();
    const canSubmit = trimmed.length >= MIN_HANDLE_LENGTH && !busy;

    // Pre-fetch the current user's handle so the self-request guard in
    // handleSubmit can compare against it before doing the target lookup.
    useEffect(() => {
        let active = true;
        (async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) return;
            const { data, error: queryError } = await supabase
                .from('profiles')
                .select('handle')
                .eq('id', userId)
                .single();
            if (queryError) {
                console.error('own-handle fetch failed:', queryError);
                return;
            }
            if (active && data) setMyHandle(data.handle);
        })();
        return () => {
            active = false;
        };
    }, []);

    async function handleSubmit() {
        if (!canSubmit) return;

        // Self-request guard — block before the lookup so we don't bother
        // querying for the user's own profile just to reject it.
        if (myHandle && trimmed === myHandle) {
            Alert.alert("That's you!", "You can't send a friend request to yourself.");
            return;
        }

        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Look up the target user by handle.
            const { data: target, error: lookupError } = await supabase
                .from('profiles')
                .select('id')
                .eq('handle', trimmed)
                .maybeSingle();
            if (lookupError) throw lookupError;
            if (!target) {
                Alert.alert('Not found', `No user found with handle @${trimmed}`);
                return;
            }

            // The INSERT policy enforces no-existing-friendship and
            // no-reverse-pending-request via can_send_friend_request;
            // the unique constraint on (from, to) catches duplicate sends.
            // Any of those failures surface as a Postgrest error here.
            const { error: insertError } = await supabase
                .from('friend_requests')
                .insert({ from_user_id: userId, to_user_id: target.id });
            if (insertError) throw insertError;

            Alert.alert('Sent', 'Friend request sent.', [
                { text: 'OK', onPress: () => router.back() },
            ]);
        } catch (err) {
            console.error('send friend request failed:', err);
            surfaceError(err, "Couldn't send request");
        } finally {
            setBusy(false);
        }
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
                    <ChevronLeft color={palette.accent} size={28} />
                </Pressable>
                <Text style={[typography.heading, { color: palette.text }]}>
                    Add a friend
                </Text>
            </View>

            <View style={styles.body}>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Enter their handle to send a friend request.
                </Text>

                <View
                    style={[
                        styles.inputRow,
                        { backgroundColor: palette.surface, borderColor: palette.border },
                    ]}
                >
                    <Text
                        style={[
                            typography.body,
                            styles.atPrefix,
                            { color: palette.textMuted },
                        ]}
                    >
                        @
                    </Text>
                    <TextInput
                        value={handle}
                        onChangeText={setHandle}
                        placeholder="handle"
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        spellCheck={false}
                        returnKeyType="send"
                        onSubmitEditing={handleSubmit}
                        editable={!busy}
                        style={[styles.input, typography.body, { color: palette.text }]}
                    />
                </View>

                <Pressable
                    onPress={handleSubmit}
                    disabled={!canSubmit}
                    style={({ pressed }) => [
                        styles.submitButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: !canSubmit ? 0.4 : pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    {busy ? (
                        <ActivityIndicator color={palette.textInverse} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Send request
                        </Text>
                    )}
                </Pressable>
            </View>
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
        // Code 42501 on this screen means the friend_requests INSERT was
        // rejected by RLS — i.e. can_send_friend_request returned false
        // (existing friendship, reverse pending request, or otherwise
        // ineligible). The raw Postgres message ("new row violates row-
        // level security policy for table 'friend_requests'") is jargon;
        // replace with something the user can act on.
        if (supaErr.code === '42501') {
            Alert.alert(
                title,
                "Can't send a request to this user right now. You might already be friends, or there's an existing request between you.",
            );
            return;
        }
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
    body: {
        flex: 1,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.lg,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        height: 48,
        borderRadius: radius.sm,
        borderWidth: 1,
        gap: spacing.xs,
    },
    atPrefix: { fontWeight: '600' },
    input: { flex: 1, height: '100%' },
    submitButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
