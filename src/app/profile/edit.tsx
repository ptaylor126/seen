import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { useProfile } from '@/hooks/use-profile';
import supabase from '@/lib/supabase';
import {
    getPalette,
    ICON_STROKE_WIDTH,
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

    const [displayName, setDisplayName] = useState('');
    const [saving, setSaving] = useState(false);

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

    // Baseline = the currently-saved name. Trimming both sides so
    // leading/trailing whitespace can't fake a dirty flag in either
    // direction.
    const baseline = (profile?.displayName ?? '').trim();
    const trimmed = displayName.trim();
    const isDirty = trimmed !== baseline;
    const isValid =
        trimmed.length > 0 && trimmed.length <= MAX_DISPLAY_NAME_LENGTH;
    const canSave = isDirty && isValid && !saving;

    async function handleSave() {
        if (!canSave) return;
        setSaving(true);
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

            // Push the new value into the shared profile context so
            // the previous screen (and any consumer of useProfile)
            // reads the fresh value the instant we navigate back.
            await refresh();
            router.back();
        } catch (err) {
            console.error('profile edit save failed:', err);
            Alert.alert(
                "Couldn't save",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setSaving(false);
        }
    }

    function handleChangePhoto() {
        // Photo upload requires expo-image-picker + Supabase storage
        // wiring; not part of MVP. Polite stub so the affordance
        // doesn't look broken.
        Alert.alert('Photo editing coming soon');
    }

    // Header is rendered in every branch (loading and ready), so it's
    // extracted to avoid duplication. `actionLabel` is the right-side
    // button — disabled-styled grey when no changes, accent when there
    // are unsaved changes ready to commit.
    function renderHeader() {
        return (
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.headerSide,
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <ChevronLeft
                        color={palette.text}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
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
                <Pressable
                    onPress={handleSave}
                    disabled={!canSave}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.headerSide,
                        styles.headerSideEnd,
                        pressed && canSave && { opacity: 0.6 },
                    ]}
                >
                    {saving ? (
                        <ActivityIndicator color={palette.accent} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                {
                                    color: canSave
                                        ? palette.accent
                                        : palette.textMuted,
                                },
                            ]}
                        >
                            Save
                        </Text>
                    )}
                </Pressable>
            </View>
        );
    }

    if (status === 'loading' || !profile) {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                {renderHeader()}
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            </SafeAreaView>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
                            <Pressable
                                onPress={handleChangePhoto}
                                hitSlop={spacing.sm}
                                style={({ pressed }) => [
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Change photo
                                </Text>
                            </Pressable>
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
                                value={displayName}
                                onChangeText={setDisplayName}
                                placeholder="Your display name"
                                placeholderTextColor={palette.textMuted}
                                maxLength={MAX_DISPLAY_NAME_LENGTH}
                                autoCapitalize="words"
                                autoCorrect={false}
                                returnKeyType="done"
                                onSubmitEditing={() => {
                                    if (canSave) void handleSave();
                                }}
                                editable={!saving}
                                style={[
                                    styles.textInput,
                                    typography.body,
                                    {
                                        backgroundColor: palette.surface,
                                        borderColor: palette.border,
                                        color: palette.text,
                                    },
                                ]}
                            />
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
