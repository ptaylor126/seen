import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import {
    CaretLeft,
    Check,
} from 'phosphor-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { Avatar } from '@/components/avatar';
import { useToast } from '@/components/toast';
import { useProfile } from '@/hooks/use-profile';
import { pickAndUploadAvatar, removeAvatar } from '@/lib/avatar-upload';
import supabase from '@/lib/supabase';
import {
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

const MAX_DISPLAY_NAME_LENGTH = 30;
const AVATAR_SIZE = 96;
export default function EditProfileScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { status, profile, refresh } = useProfile();
    const showLoader = useDeferredLoading(status === 'loading' || !profile);

    const nameInputRef = useRef<TextInput | null>(null);

    const [displayName, setDisplayName] = useState('');
    const [nameSaving, setNameSaving] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);

    // Hydrate the editable input from the profile context exactly once.
    // We deliberately DO NOT keep a second state slot for the baseline:
    // the previous implementation set displayName and initialDisplayName
    // in the same effect, which raced with autoFocus-driven keystrokes
    // — fast typers got their input clobbered when the effect committed,
    // and the dirty check then compared two equal values. Reading the
    // baseline straight off the context every render means there's only
    // one source of truth and nothing to drift against.
    const hydratedRef = useRef(false);
    useEffect(() => {
        if (profile && !hydratedRef.current) {
            setDisplayName(profile.displayName);
            hydratedRef.current = true;
        }
    }, [profile]);

    // ---- Saved toast — the shared ambient toast (extracted from this
    // screen's original local implementation once a second consumer
    // appeared; see src/components/toast.tsx).
    const { showToast, toast } = useToast();
    const showSavedToast = useCallback(() => {
        showToast('Saved', <Check color={palette.success} size={16} />);
    }, [showToast, palette.success]);

    // ---- Display-name commit
    //
    // Shared between two trigger points: the TextInput's onBlur (the
    // standard "user moved away from the field" case) AND the back
    // chevron handler (so a typed-but-not-yet-blurred change still
    // commits regardless of platform — relying on iOS's implicit
    // blur-on-tap-outside doesn't work on Android, and we want one
    // consistent behavior).
    const commitNameIfChanged = useCallback(async (): Promise<boolean> => {
        if (!profile || nameSaving) return true;
        const trimmed = displayName.trim();
        const baseline = profile.displayName.trim();
        if (trimmed === baseline) return true; // nothing to do

        if (trimmed.length === 0) {
            // Invalid — don't save, surface inline error. Returns true
            // so callers (including the back handler) can treat
            // validation failure as "navigate anyway, discard"; the
            // alternative (block navigation on invalid) would trap the
            // user with no Save button.
            setNameError("Name can't be empty");
            return true;
        }

        setNameError(null);
        setNameSaving(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { error } = await supabase
                .from('profiles')
                .update({ display_name: trimmed })
                .eq('id', userId);
            if (error) throw error;

            await refresh();
            showSavedToast();
            return true;
        } catch (err) {
            console.error('profile name save failed:', err);
            Alert.alert(
                "Couldn't save",
                err instanceof Error ? err.message : 'Unknown error',
            );
            return false;
        } finally {
            setNameSaving(false);
        }
    }, [displayName, profile, nameSaving, refresh, showSavedToast]);

    function handleNameBlur() {
        void commitNameIfChanged();
    }

    function handleNameChange(value: string) {
        setDisplayName(value);
        // Clear an inline error as soon as the user resumes typing so
        // they're not staring at a stale "can't be empty" while they
        // type a valid value.
        if (nameError) setNameError(null);
    }

    async function handleBack() {
        // Commit any pending name change BEFORE navigating. Don't rely
        // on the back tap implicitly blurring the input — that's a
        // platform-dependent behaviour and would silently lose a typed
        // name change on Android. Validation failures still navigate
        // (user can fix on re-entry); save failures surface their own
        // Alert from inside commitNameIfChanged.
        await commitNameIfChanged();
        router.back();
    }

    const [avatarBusy, setAvatarBusy] = useState(false);

    async function handleChangePhoto() {
        if (!profile || avatarBusy) return;
        setAvatarBusy(true);
        try {
            const result = await pickAndUploadAvatar({
                userId: profile.id,
                previousAvatarUrl: profile.avatarUrl,
            });
            switch (result.kind) {
                case 'uploaded':
                    // refresh re-fetches profiles row from the DB. The
                    // shared ProfileContext propagates to every consumer
                    // (root layout, Profile screen, edit screen), and
                    // every other site that renders this user's avatar
                    // picks up the new URL on its next focus/mount.
                    await refresh();
                    showSavedToast();
                    break;
                case 'cancelled':
                    // User backed out of the picker. No-op.
                    break;
                case 'permission_denied':
                    Alert.alert(
                        'Photos permission needed',
                        "Seen can't access your photos. Enable Photos access in Settings to set a profile picture.",
                        [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Open Settings',
                                onPress: () => {
                                    Linking.openSettings().catch(() => {
                                        // No-op — some platforms reject
                                        // openSettings; nothing useful to
                                        // surface here.
                                    });
                                },
                            },
                        ],
                    );
                    break;
                case 'failed':
                    Alert.alert("Couldn't update photo", result.message);
                    break;
            }
        } finally {
            setAvatarBusy(false);
        }
    }

    async function handleRemovePhoto() {
        if (!profile || avatarBusy || !profile.avatarUrl) return;
        const confirmed = await new Promise<boolean>((resolve) => {
            Alert.alert(
                'Remove photo?',
                'Your initial will show instead.',
                [
                    {
                        text: 'Cancel',
                        style: 'cancel',
                        onPress: () => resolve(false),
                    },
                    {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () => resolve(true),
                    },
                ],
                { cancelable: true, onDismiss: () => resolve(false) },
            );
        });
        if (!confirmed) return;

        setAvatarBusy(true);
        try {
            const result = await removeAvatar({
                userId: profile.id,
                previousAvatarUrl: profile.avatarUrl,
            });
            if (result.kind === 'removed') {
                await refresh();
                showSavedToast();
            } else {
                Alert.alert("Couldn't remove photo", result.message);
            }
        } finally {
            setAvatarBusy(false);
        }
    }

    // Header rendered in every branch (loading and ready). Save button
    // is gone — name and avatar save on blur / on upload respectively.
    // The right side keeps an empty placeholder so the title stays
    // horizontally centered against the asymmetric back-chevron on the
    // left (same spacer pattern used in friends/add.tsx).
    function renderHeader() {
        return (
            <View style={styles.header}>
                <Pressable
                    onPress={handleBack}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.headerSide,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <CaretLeft
                        color={palette.text}
                        size={28}
                    />
                </Pressable>
                <Text
                    style={[
                        typography.heading,
                        styles.headerTitle,
                        { color: palette.text },
                    ]}
                    numberOfLines={1}
                >
                    Edit profile
                </Text>
                <View style={[styles.headerSide, styles.headerSideEnd]} />
            </View>
        );
    }

    if (showLoader) {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                {renderHeader()}
                <FullScreenLoader />
            </SafeAreaView>
        );
    }

    // Unreachable: showLoader (busy) is true whenever status==='loading' ||
    // !profile, so reaching here means the profile is loaded — this also
    // narrows the type for the JSX below.
    if (!profile) return null;

    return (
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior="padding"
            >
                <SafeAreaView style={styles.root} edges={['top']}>
                    {renderHeader()}

                    <View style={styles.body}>
                        <View style={styles.avatarBlock}>
                            <Avatar
                                avatarUrl={profile.avatarUrl}
                                displayName={profile.displayName}
                                seedId={profile.id}
                                size={AVATAR_SIZE}
                            />
                            <View style={styles.avatarActions}>
                                <Pressable
                                    onPress={handleChangePhoto}
                                    hitSlop={spacing.sm}
                                    disabled={avatarBusy}
                                    style={({ pressed }) => [
                                        pressed && !avatarBusy && { opacity: 0.6 },
                                        avatarBusy && { opacity: 0.5 },
                                    ]}
                                >
                                    {avatarBusy ? (
                                        <ActivityIndicator
                                            color={palette.accent}
                                        />
                                    ) : (
                                        <Text
                                            style={[
                                                typography.body,
                                                { color: palette.accent },
                                            ]}
                                        >
                                            Change photo
                                        </Text>
                                    )}
                                </Pressable>
                                {profile.avatarUrl && !avatarBusy ? (
                                    <Pressable
                                        onPress={handleRemovePhoto}
                                        hitSlop={spacing.sm}
                                        style={({ pressed }) => [
                                            pressed && { opacity: 0.6 },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.caption,
                                                { color: palette.textMuted },
                                            ]}
                                        >
                                            Remove photo
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        </View>

                        <View style={styles.field}>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Display name
                            </Text>
                            <TextInput
                                ref={nameInputRef}
                                value={displayName}
                                onChangeText={handleNameChange}
                                onBlur={handleNameBlur}
                                placeholder="Your display name"
                                placeholderTextColor={palette.textMuted}
                                maxLength={MAX_DISPLAY_NAME_LENGTH}
                                autoCapitalize="words"
                                autoCorrect={false}
                                returnKeyType="done"
                                // Submit dismisses the keyboard, which
                                // fires onBlur and routes through the
                                // standard commit path. No bespoke
                                // duplicate save here.
                                onSubmitEditing={() => {
                                    nameInputRef.current?.blur();
                                }}
                                editable={!nameSaving}
                                style={[
                                    styles.textInput,
                                    typography.body,
                                    {
                                        backgroundColor: palette.surface,
                                        borderColor: nameError
                                            ? palette.error
                                            : palette.border,
                                        color: palette.text,
                                    },
                                ]}
                            />
                            {nameError ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.error },
                                    ]}
                                >
                                    {nameError}
                                </Text>
                            ) : null}
                            <Text
                                style={[
                                    typography.micro,
                                    styles.counter,
                                    { color: palette.textMuted },
                                ]}
                            >
                                {displayName.length}/{MAX_DISPLAY_NAME_LENGTH}
                            </Text>
                        </View>

                        <View style={styles.field}>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Handle
                            </Text>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.textMuted },
                                ]}
                            >
                                @{profile.handle}
                            </Text>
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.textMuted },
                                ]}
                            >
                                Handle editing not available yet. Contact
                                support if you need to change it.
                            </Text>
                        </View>
                    </View>
                </SafeAreaView>
            </KeyboardAvoidingView>
            {toast}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
    // Three-column header: left/center/right with equal flex on the
    // sides so the title stays geometrically centred regardless of how
    // wide the back button or the Save label are.
    headerSide: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    headerSideEnd: {
        justifyContent: 'flex-end',
    },
    headerTitle: {
        flex: 2,
        textAlign: 'center',
    },
    fillCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    body: {
        flex: 1,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.xl,
    },
    avatarBlock: {
        alignItems: 'center',
        gap: spacing.sm,
    },
    avatarActions: {
        // Stacked action labels under the avatar — "Change photo" on
        // top (primary affordance), "Remove photo" below (smaller,
        // muted) when one is set. Tight gap so the pair reads as one
        // affordance group.
        alignItems: 'center',
        gap: spacing.xs,
    },
    field: {
        gap: spacing.xs,
    },
    textInput: {
        height: 48,
        borderRadius: radius.md,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
    },
    counter: {
        alignSelf: 'flex-end',
    },
});
