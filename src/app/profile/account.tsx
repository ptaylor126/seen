import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { signOut } from '@/lib/auth';
import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Typed exactly to enable the destructive button — guards against an
// accidental tap deleting an account.
const CONFIRM_WORD = 'DELETE';

export default function AccountScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();

    const [confirmVisible, setConfirmVisible] = useState(false);
    const [confirmText, setConfirmText] = useState('');
    const [deleting, setDeleting] = useState(false);

    const canDelete = confirmText.trim().toUpperCase() === CONFIRM_WORD;

    function openConfirm() {
        setConfirmText('');
        setConfirmVisible(true);
    }

    function closeConfirm() {
        if (deleting) return; // don't let it dismiss mid-delete
        setConfirmVisible(false);
    }

    async function handleDelete() {
        if (!canDelete || deleting) return;
        setDeleting(true);
        try {
            // uid is derived server-side from the JWT (auto-attached by
            // functions.invoke) — no body needed. The function aborts on
            // any failure before deleting the auth user, so a non-2xx here
            // means nothing was deleted and the account is intact.
            const { error } = await supabase.functions.invoke('delete-account');
            if (error) throw error;

            setDeleting(false);
            setConfirmVisible(false);
            // Success. The server account is already gone. Inform the user
            // (incl. the Apple revocation step), THEN sign out — signing out
            // first would unmount this screen before the note shows.
            Alert.alert(
                'Account deleted',
                'Your account and all your data have been permanently ' +
                    'deleted.\n\nTo finish disconnecting Sign in with Apple, ' +
                    'open Settings → Apple ID → Sign in with Apple → Seen → ' +
                    'Stop Using. Your account is already deleted whether or ' +
                    'not you do this.',
                [
                    {
                        text: 'OK',
                        onPress: () => {
                            // Clears the (now-invalid) local session →
                            // root layout redirects to sign-in. Swallow any
                            // error: the account is gone, so a failed
                            // server-side revoke is irrelevant.
                            void signOut().catch((err) => {
                                console.warn(
                                    'sign-out after deletion failed (ignored):',
                                    err,
                                );
                            });
                        },
                    },
                ],
                { cancelable: false },
            );
        } catch (err) {
            // Transactional RPC + abort-on-failure ordering means a failure
            // deleted nothing. Keep the user signed in and let them retry.
            setDeleting(false);
            console.error('delete account failed:', err);
            Alert.alert(
                "Couldn't delete account",
                'Something went wrong and nothing was deleted. Please check ' +
                    'your connection and try again.',
            );
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
                    Account
                </Text>
            </View>

            <View
                style={[
                    styles.body,
                    // edges={['top']} doesn't reserve the bottom inset, so base
                    // the bottom padding on the real one. Android: insets.bottom
                    // + md clears the nav bar. iOS: xl (32) was actually below
                    // the home-indicator inset (~46), so this also nudges the
                    // button up to clear it; non-home-indicator iOS (inset 0)
                    // stays at xl.
                    {
                        paddingBottom: Math.max(
                            spacing.xl,
                            insets.bottom + spacing.md,
                        ),
                    },
                ]}
            >
                {/* Non-destructive settings, kept clearly separate from the
                    destructive Delete block at the bottom. */}
                <Pressable
                    onPress={() => router.push('/profile/blocked')}
                    accessibilityRole="button"
                    accessibilityLabel="Blocked users"
                    style={({ pressed }) => [
                        styles.settingsRow,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <Text
                        style={[
                            typography.body,
                            styles.settingsLabel,
                            { color: palette.text },
                        ]}
                    >
                        Blocked users
                    </Text>
                    <ChevronRight
                        color={palette.textMuted}
                        size={20}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>

                {/* Spacer keeps the destructive Delete block pinned at the
                    bottom, visually distinct from the neutral row above. */}
                <View style={styles.flexSpacer} />

                {/* Delete account — prominent (not buried in a submenu) per
                    Apple guideline 5.1.1(v), styled destructive. */}
                <View style={styles.deleteBlock}>
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.text },
                        ]}
                    >
                        Delete account
                    </Text>
                    <Text
                        style={[
                            typography.caption,
                            { color: palette.textMuted },
                        ]}
                    >
                        Permanently delete your account and everything in it.
                        This can&apos;t be undone.
                    </Text>
                    <Pressable
                        onPress={openConfirm}
                        accessibilityRole="button"
                        accessibilityLabel="Delete account"
                        style={({ pressed }) => [
                            styles.deleteButton,
                            {
                                borderColor: palette.error,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.error },
                            ]}
                        >
                            Delete account
                        </Text>
                    </Pressable>
                </View>
            </View>

            {/* Confirmation: lists what's removed + requires typing DELETE. */}
            <Modal
                visible={confirmVisible}
                transparent
                animationType="fade"
                onRequestClose={closeConfirm}
            >
                {/* Lift the centered card above the keyboard so the Delete /
                    Cancel buttons stay visible + tappable while typing.
                    keyboard-controller KAV, padding on both platforms. Note:
                    inside an RN Modal, whose Android window the library's inset
                    handling may not reach — verify on device (commit 5). */}
                <KeyboardAvoidingView
                    style={styles.modalFlex}
                    behavior="padding"
                >
                    <View style={[styles.modalContainer, { backgroundColor: palette.overlay }]}>
                        <Pressable
                            style={StyleSheet.absoluteFill}
                            onPress={closeConfirm}
                            accessibilityElementsHidden
                        />
                    <View
                        style={[
                            styles.modalCard,
                            { backgroundColor: palette.surface },
                        ]}
                    >
                        <Text
                            style={[
                                typography.heading,
                                styles.modalTitle,
                                { color: palette.text },
                            ]}
                        >
                            Delete account?
                        </Text>
                        <Text
                            style={[
                                typography.body,
                                styles.modalBody,
                                { color: palette.textMuted },
                            ]}
                        >
                            This permanently deletes your account and all your
                            data: your profile, library, ratings, reviews,
                            recommendations you&apos;ve sent and received,
                            friends, photos, and feedback. This cannot be
                            undone.
                        </Text>
                        <Text
                            style={[
                                typography.caption,
                                styles.modalPrompt,
                                { color: palette.textMuted },
                            ]}
                        >
                            Type {CONFIRM_WORD} to confirm.
                        </Text>
                        <TextInput
                            value={confirmText}
                            onChangeText={setConfirmText}
                            editable={!deleting}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            placeholder={CONFIRM_WORD}
                            placeholderTextColor={palette.textMuted}
                            style={[
                                styles.input,
                                typography.body,
                                {
                                    color: palette.text,
                                    backgroundColor: palette.bg,
                                    borderColor: palette.border,
                                },
                            ]}
                        />
                        <Pressable
                            onPress={handleDelete}
                            disabled={!canDelete || deleting}
                            accessibilityRole="button"
                            accessibilityLabel="Permanently delete my account"
                            style={({ pressed }) => [
                                styles.modalDeleteButton,
                                {
                                    backgroundColor: palette.error,
                                    opacity:
                                        !canDelete || deleting
                                            ? 0.4
                                            : pressed
                                              ? 0.6
                                              : 1,
                                },
                            ]}
                        >
                            {deleting ? (
                                <ActivityIndicator color={palette.textInverse} />
                            ) : (
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.textInverse },
                                    ]}
                                >
                                    Delete account
                                </Text>
                            )}
                        </Pressable>
                        <Pressable
                            onPress={closeConfirm}
                            disabled={deleting}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            style={({ pressed }) => [
                                styles.modalCancel,
                                { opacity: pressed || deleting ? 0.6 : 1 },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Cancel
                            </Text>
                        </Pressable>
                    </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
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
    body: {
        flex: 1,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        paddingBottom: spacing.xl,
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
    },
    settingsLabel: { flex: 1 },
    flexSpacer: { flex: 1 },
    deleteBlock: {
        gap: spacing.sm,
    },
    deleteButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        marginTop: spacing.sm,
    },
    modalFlex: { flex: 1 },
    modalContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    modalCard: {
        width: '100%',
        borderRadius: radius.lg,
        padding: spacing.lg,
        gap: spacing.sm,
    },
    modalTitle: {
        textAlign: 'center',
    },
    modalBody: {
        textAlign: 'center',
    },
    modalPrompt: {
        textAlign: 'center',
        marginTop: spacing.sm,
    },
    input: {
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        textAlign: 'center',
        letterSpacing: 2,
    },
    modalDeleteButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        marginTop: spacing.md,
        minHeight: 48,
    },
    modalCancel: {
        alignSelf: 'center',
        paddingVertical: spacing.md,
        marginTop: spacing.xs,
    },
});
