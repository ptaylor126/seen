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

import { Avatar } from '@/components/avatar';
import { shareInvite } from '@/lib/invite';
import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

const MIN_HANDLE_LENGTH = 3;
const MATCH_AVATAR_SIZE = 44;


export default function AddFriendScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [handle, setHandle] = useState('');
    // Lookup ("Find") in flight.
    const [busy, setBusy] = useState(false);
    // The single exact match from handleLookup, shown for confirmation before
    // the request is sent. null = nothing matched / not looked up yet.
    const [match, setMatch] = useState<{
        id: string;
        handle: string;
        displayName: string | null;
        avatarUrl: string | null;
    } | null>(null);
    // Friend-request insert in flight (the confirmed "Send request" step).
    const [sending, setSending] = useState(false);
    const [myHandle, setMyHandle] = useState<string | null>(null);

    const trimmed = handle.trim().toLowerCase();
    const canSubmit = trimmed.length >= MIN_HANDLE_LENGTH && !busy;

    // Pre-fetch the current user's handle so the self-request guard in
    // handleLookup can compare against it before doing the target lookup.
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

    // Open the OS share sheet with the App Store link (shared shareInvite).
    function handleInvite() {
        void shareInvite();
    }

    // Step 1 — exact-handle lookup. Resolves the single matching profile so
    // the user can confirm it's the right person BEFORE the request is sent.
    // Still exact-match (.eq) — no fuzzy/prefix search, no browsing by partial
    // handle. The widened select pulls display_name + avatar for the card.
    async function handleLookup() {
        if (!canSubmit) return;

        // Self-request guard — block before the lookup so we don't bother
        // querying for the user's own profile just to reject it.
        if (myHandle && trimmed === myHandle) {
            Alert.alert("That's you!", "You can't send a friend request to yourself.");
            return;
        }

        setBusy(true);
        try {
            const { data: target, error: lookupError } = await supabase
                .from('profiles')
                .select('id, handle, display_name, avatar_url')
                .eq('handle', trimmed)
                .maybeSingle();
            if (lookupError) throw lookupError;
            if (!target) {
                setMatch(null);
                Alert.alert('Not found', `No user found with handle @${trimmed}`);
                return;
            }
            setMatch({
                id: target.id,
                handle: target.handle,
                displayName: target.display_name,
                avatarUrl: target.avatar_url,
            });
        } catch (err) {
            console.error('handle lookup failed:', err);
            surfaceError(err, "Couldn't look up that handle");
        } finally {
            setBusy(false);
        }
    }

    // Step 2 — send the request to the confirmed match. The INSERT policy
    // enforces no-existing-friendship and no-reverse-pending-request via
    // can_send_friend_request; the unique constraint on (from, to) catches
    // duplicate sends. A rejected insert is mapped to a specific, plain-English
    // message by resolveSendError — which may run ONE follow-up query, only on
    // this failure path (the successful send below never queries).
    async function handleSend() {
        if (!match || sending) return;
        setSending(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error: insertError } = await supabase
                .from('friend_requests')
                .insert({ from_user_id: userId, to_user_id: match.id });
            if (insertError) {
                console.warn('friend request insert rejected:', insertError);
                const { title, message } = await resolveSendError(
                    insertError,
                    userId,
                    match,
                );
                Alert.alert(title, message);
                return;
            }

            Alert.alert('Sent', 'Friend request sent.', [
                { text: 'OK', onPress: () => router.back() },
            ]);
        } catch (err) {
            // Unexpected (network / auth) — never surface the raw error text.
            console.error('send friend request failed:', err);
            Alert.alert("Couldn't send request", 'Please try again.');
        } finally {
            setSending(false);
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
                        onChangeText={(text) => {
                            setHandle(text);
                            // Editing invalidates a shown match — require a
                            // fresh lookup before the request can be sent.
                            if (match) setMatch(null);
                        }}
                        placeholder="handle"
                        placeholderTextColor={palette.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        spellCheck={false}
                        returnKeyType="search"
                        onSubmitEditing={handleLookup}
                        editable={!busy && !sending}
                        style={[styles.input, typography.body, { color: palette.text }]}
                    />
                </View>

                {match ? (
                    // Confirmation step — show who matched so the user can be
                    // sure it's the right person before sending. Handle is
                    // primary; display name sits under it, omitted entirely
                    // when blank (no empty second line).
                    <View style={styles.matchGroup}>
                        <View
                            style={[
                                styles.matchCard,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: palette.border,
                                },
                            ]}
                        >
                            <Avatar
                                avatarUrl={match.avatarUrl}
                                displayName={match.displayName || match.handle}
                                seedId={match.id}
                                size={MATCH_AVATAR_SIZE}
                            />
                            <View style={styles.matchText}>
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={1}
                                >
                                    @{match.handle}
                                </Text>
                                {match.displayName && match.displayName.trim() ? (
                                    <Text
                                        style={[
                                            typography.caption,
                                            { color: palette.textMuted },
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {match.displayName.trim()}
                                    </Text>
                                ) : null}
                            </View>
                        </View>

                        <Pressable
                            onPress={handleSend}
                            disabled={sending}
                            style={({ pressed }) => [
                                styles.submitButton,
                                {
                                    backgroundColor: palette.accent,
                                    opacity: sending ? 0.4 : pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            {sending ? (
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
                ) : (
                    <Pressable
                        onPress={handleLookup}
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
                                Find
                            </Text>
                        )}
                    </Pressable>
                )}

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

// Turn a failed friend_requests INSERT into a specific, plain-English message.
// The error CODE distinguishes the unique-constraint duplicate (23505) from the
// RLS rejection (42501). 42501 alone can't say WHY can_send_friend_request()
// returned false, so we probe the pair — both the friendship and the reverse
// request are visible under the caller's OWN RLS — to pick the right message.
// IMPORTANT: this follow-up query runs ONLY here, on a rejected insert, never on
// a successful send. A block where WE were blocked is intentionally invisible to
// us (blocks_select_own), so it falls through to the soft generic — we must not
// reveal a block.
async function resolveSendError(
    err: unknown,
    myId: string,
    target: { id: string; handle: string },
): Promise<{ title: string; message: string }> {
    const code =
        err && typeof err === 'object' && 'code' in err
            ? (err as { code?: string }).code
            : undefined;

    // Duplicate (from_user_id, to_user_id) — we already sent this person one.
    if (code === '23505') {
        return {
            title: 'Already sent',
            message: `You've already sent @${target.handle} a request.`,
        };
    }

    // RLS rejection — probe the pair to explain why can_send returned false.
    if (code === '42501') {
        // friendships are keyed lexicographically (user_a_id < user_b_id).
        const [a, b] =
            myId < target.id ? [myId, target.id] : [target.id, myId];
        const { data: friendship } = await supabase
            .from('friendships')
            .select('user_a_id')
            .eq('user_a_id', a)
            .eq('user_b_id', b)
            .maybeSingle();
        if (friendship) {
            return {
                title: 'Already friends',
                message: `You're already friends with @${target.handle}.`,
            };
        }
        // Did THEY already send US a request? (visible: to_user_id = me)
        const { data: reverse } = await supabase
            .from('friend_requests')
            .select('id')
            .eq('from_user_id', target.id)
            .eq('to_user_id', myId)
            .maybeSingle();
        if (reverse) {
            return {
                title: 'Request pending',
                message: `@${target.handle} already sent you a request. Check your Requests to accept it.`,
            };
        }
        // Otherwise a block (invisible to us) or an edge case — soft generic.
        return {
            title: "Couldn't send request",
            message: `You can't send @${target.handle} a request right now.`,
        };
    }

    // Network / unexpected — never surface the raw Postgres error text.
    return {
        title: "Couldn't send request",
        message: 'Please try again.',
    };
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
        // No gap — the "@" prefix sits flush against the typed text so it
        // reads "@paul", not "@ paul".
    },
    atPrefix: { fontWeight: '600' },
    input: { flex: 1, height: '100%' },
    submitButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Confirmation card + Send button kept snug as one unit; the body's
    // larger gap separates it from the input above and the invite group below.
    matchGroup: { gap: spacing.md },
    matchCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
    // 2pt between the handle and the display name under it.
    matchText: { flex: 1, gap: 2 },
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
