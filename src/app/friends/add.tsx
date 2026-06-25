import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Platform,
    Pressable,
    Share,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

const MIN_HANDLE_LENGTH = 3;

// "Invite friends" share. Simple version: shares the App Store link with a
// short pitch via the OS share sheet. It does NOT auto-connect the recipient
// as a friend — that's the deferred deep-link project (see the invite-link
// note further down + src/app/friends/invite.tsx).
const APP_STORE_URL = 'https://apps.apple.com/app/id6775920785';
const INVITE_PITCH =
    'Join me on Seen — recommendations from friends you actually trust.';

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

    // Open the OS share sheet with the App Store link. On iOS the link is
    // passed as a separate `url` item so iOS builds a rich LinkPresentation
    // preview — for an apps.apple.com URL that's the Seen app icon + name
    // pulled from the listing (the share-sheet thumbnail). Android's Share
    // ignores `url`, so there the link goes inline in the message text. A
    // cancel rejects the promise, which we swallow.
    async function handleInvite() {
        try {
            await Share.share(
                Platform.OS === 'ios'
                    ? { message: INVITE_PITCH, url: APP_STORE_URL }
                    : { message: `${INVITE_PITCH} ${APP_STORE_URL}` },
            );
        } catch (err) {
            console.error('invite share failed:', err);
        }
    }

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
                    <ChevronLeft
                        color={palette.accent}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
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

                {/* Invite action — sits directly under the handle form.
                    (The old in-app invite-link affordance was removed
                    because that URL doesn't deep-link yet; this just
                    shares the App Store link — no auto-connect. The
                    backend invite_links + claim_invite_link path stays in
                    place for when the deferred Universal Link / App Link
                    work lands; see src/app/friends/invite.tsx.) */}
                <View style={styles.inviteGroup}>
                    <Text
                        style={[
                            typography.caption,
                            styles.inviteCaption,
                            { color: palette.textMuted },
                        ]}
                    >
                        Know someone who&apos;s not on Seen yet?
                    </Text>
                    <Pressable
                        onPress={handleInvite}
                        style={({ pressed }) => [
                            styles.inviteButton,
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
                            Invite friends
                        </Text>
                    </Pressable>
                </View>
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
    // Caption + button kept snug together (own gap); the body's larger gap
    // sets the group apart from the "Send request" button above.
    inviteGroup: { gap: spacing.sm },
    inviteCaption: { textAlign: 'center' },
    // Secondary (outlined) action — same shape as submitButton but a coral
    // outline instead of a fill, so it reads below the primary "Send
    // request". Mirrors the secondary button in friends/invite.tsx.
    inviteButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
