import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Check, ChevronLeft, ImagePlus, X } from 'lucide-react-native';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { pickFeedbackImage, uploadFeedbackScreenshot } from '@/lib/feedback-upload';
import supabase from '@/lib/supabase';
import {
    button,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Same device string the previous mailto used, so the value in the
// feedback email is unchanged.
function deviceLabel(): string {
    return Platform.OS === 'ios'
        ? `iOS ${Platform.Version}`
        : `Android API ${Platform.Version}`;
}

// Basic "looks like an email" shape check — intentionally loose (the
// reply address is optional and best-effort, not an auth credential).
function isPlausibleEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function FeedbackScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();

    const [body, setBody] = useState('');
    const [replyEmail, setReplyEmail] = useState('');
    const [emailError, setEmailError] = useState<string | null>(null);
    const [attachedUri, setAttachedUri] = useState<string | null>(null);
    const [attaching, setAttaching] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const canSubmit = body.trim().length > 0 && !submitting;

    async function handleAttach() {
        if (attaching || submitting) return;
        setAttaching(true);
        try {
            const result = await pickFeedbackImage();
            switch (result.kind) {
                case 'picked':
                    setAttachedUri(result.uri);
                    break;
                case 'cancelled':
                    break;
                case 'permission_denied':
                    Alert.alert(
                        'Photos permission needed',
                        "Seen can't access your photos. Enable Photos access in Settings to attach a screenshot.",
                        [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Open Settings',
                                onPress: () => {
                                    Linking.openSettings().catch(() => {});
                                },
                            },
                        ],
                    );
                    break;
                case 'failed':
                    Alert.alert("Couldn't attach image", result.message);
                    break;
            }
        } finally {
            setAttaching(false);
        }
    }

    async function handleSubmit() {
        if (!canSubmit) return;
        // The reply email is optional and does NOT gate the button, but if
        // the user typed something it must look like an email — block this
        // submit attempt and surface the inline error rather than sending a
        // typo'd address they'd expect a reply at.
        const trimmedEmail = replyEmail.trim();
        if (trimmedEmail.length > 0 && !isPlausibleEmail(trimmedEmail)) {
            setEmailError("That doesn't look like an email address.");
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not signed in.');

            // Upload the screenshot first (if attached) so we can pass its
            // path to the function. A failure here surfaces inline and the
            // typed text is kept.
            let screenshotPath: string | undefined;
            if (attachedUri) {
                screenshotPath = await uploadFeedbackScreenshot({
                    userId,
                    localUri: attachedUri,
                });
            }

            const { error: fnError } = await supabase.functions.invoke(
                'submit-feedback',
                {
                    body: {
                        body: body.trim(),
                        screenshot_path: screenshotPath,
                        reply_email:
                            trimmedEmail.length > 0 ? trimmedEmail : undefined,
                        app_version: Constants.expoConfig?.version ?? 'unknown',
                        device: deviceLabel(),
                    },
                },
            );
            if (fnError) throw fnError;

            // Success — clear the form and switch to the confirmation
            // state. (Keeps nothing typed behind the success screen.)
            setBody('');
            setReplyEmail('');
            setEmailError(null);
            setAttachedUri(null);
            setSent(true);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Something went wrong. Please try again.',
            );
        } finally {
            setSubmitting(false);
        }
    }

    function renderHeader() {
        return (
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
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
                    Send feedback
                </Text>
                <View style={[styles.headerSide, styles.headerSideEnd]} />
            </View>
        );
    }

    // ---- Success confirmation (persistent, not a transient toast).
    if (sent) {
        return (
            <SafeAreaView
                style={[styles.root, { backgroundColor: palette.bg }]}
                edges={['top']}
            >
                {renderHeader()}
                <View style={styles.confirmBlock}>
                    <View
                        style={[
                            styles.confirmIcon,
                            { backgroundColor: palette.accentSubtle },
                        ]}
                    >
                        <Check
                            color={palette.accent}
                            size={32}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </View>
                    <Text
                        style={[
                            typography.heading,
                            styles.confirmTitle,
                            { color: palette.text },
                        ]}
                    >
                        Sent!
                    </Text>
                    <Text
                        style={[
                            typography.body,
                            styles.confirmBody,
                            { color: palette.textMuted },
                        ]}
                    >
                        Thank you for your feedback
                    </Text>
                    <Pressable
                        onPress={() => router.back()}
                        style={({ pressed }) => [
                            styles.primaryButton,
                            // alignSelf stretch so it fills the centered
                            // confirm block to a proper full-width primary
                            // button — matching the "Send feedback" button —
                            // instead of shrinking to the label width.
                            styles.confirmButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: pressed ? 0.85 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Done
                        </Text>
                    </Pressable>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior="padding"
            >
                <SafeAreaView style={styles.root} edges={['top']}>
                    {renderHeader()}

                    <View style={styles.body}>
                        <TextInput
                            value={body}
                            onChangeText={(value) => {
                                setBody(value);
                                if (error) setError(null);
                            }}
                            placeholder="What's on your mind?"
                            placeholderTextColor={palette.textMuted}
                            multiline
                            autoFocus
                            editable={!submitting}
                            textAlignVertical="top"
                            style={[
                                styles.textArea,
                                typography.body,
                                {
                                    backgroundColor: palette.surface,
                                    color: palette.text,
                                },
                            ]}
                        />

                        {/* Optional reply email. Doesn't gate submit; if
                            present it must look like an email (validated on
                            blur + submit). */}
                        <View>
                            <TextInput
                                value={replyEmail}
                                onChangeText={(value) => {
                                    setReplyEmail(value);
                                    if (emailError) setEmailError(null);
                                }}
                                onBlur={() => {
                                    const t = replyEmail.trim();
                                    setEmailError(
                                        t.length > 0 && !isPlausibleEmail(t)
                                            ? "That doesn't look like an email address."
                                            : null,
                                    );
                                }}
                                placeholder="Your email (optional, if you'd like a reply)"
                                placeholderTextColor={palette.textMuted}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoCorrect={false}
                                editable={!submitting}
                                style={[
                                    styles.emailInput,
                                    typography.body,
                                    {
                                        backgroundColor: palette.surface,
                                        // Borderless at rest; the red error
                                        // border only appears on invalid input.
                                        borderWidth: emailError ? 1 : 0,
                                        borderColor: palette.error,
                                        color: palette.text,
                                    },
                                ]}
                            />
                            {emailError ? (
                                <Text
                                    style={[
                                        typography.caption,
                                        styles.emailError,
                                        { color: palette.error },
                                    ]}
                                >
                                    {emailError}
                                </Text>
                            ) : null}
                        </View>

                        {/* Optional screenshot — thumbnail with a remove
                            (x) once attached, otherwise an attach button. */}
                        {attachedUri ? (
                            <View style={styles.thumbRow}>
                                <View style={styles.thumbWrap}>
                                    <Image
                                        source={{ uri: attachedUri }}
                                        style={[
                                            styles.thumb,
                                            { backgroundColor: palette.surfaceAlt },
                                        ]}
                                        contentFit="cover"
                                        transition={150}
                                    />
                                    <Pressable
                                        onPress={() => setAttachedUri(null)}
                                        hitSlop={spacing.sm}
                                        disabled={submitting}
                                        accessibilityRole="button"
                                        accessibilityLabel="Remove screenshot"
                                        style={({ pressed }) => [
                                            styles.thumbRemove,
                                            {
                                                backgroundColor: palette.text,
                                                borderColor: palette.bg,
                                            },
                                            pressed && { opacity: 0.7 },
                                        ]}
                                    >
                                        <X
                                            color={palette.bg}
                                            size={14}
                                            strokeWidth={ICON_STROKE_WIDTH}
                                        />
                                    </Pressable>
                                </View>
                                <Text
                                    style={[
                                        typography.caption,
                                        { color: palette.textMuted },
                                    ]}
                                >
                                    Screenshot attached
                                </Text>
                            </View>
                        ) : (
                            <Pressable
                                onPress={handleAttach}
                                disabled={attaching || submitting}
                                style={({ pressed }) => [
                                    styles.attachButton,
                                    { borderColor: palette.border },
                                    pressed && { opacity: 0.6 },
                                    (attaching || submitting) && { opacity: 0.5 },
                                ]}
                            >
                                {attaching ? (
                                    <ActivityIndicator color={palette.accent} />
                                ) : (
                                    <>
                                        <ImagePlus
                                            color={palette.textMuted}
                                            size={20}
                                            strokeWidth={ICON_STROKE_WIDTH}
                                        />
                                        <Text
                                            style={[
                                                typography.body,
                                                { color: palette.textMuted },
                                            ]}
                                        >
                                            Attach a screenshot
                                        </Text>
                                    </>
                                )}
                            </Pressable>
                        )}

                        {error ? (
                            <Text
                                style={[
                                    typography.caption,
                                    { color: palette.error },
                                ]}
                            >
                                {error}
                            </Text>
                        ) : null}

                        <View
                            style={[
                                styles.footer,
                                // edges={['top']} doesn't reserve the bottom
                                // inset, so base the footer padding on the real
                                // one. Android: insets.bottom + md clears the
                                // nav bar. iOS: lg (24) was below the
                                // home-indicator inset (~46), so this also
                                // nudges the footer up to clear it;
                                // non-home-indicator iOS (inset 0) stays at lg.
                                {
                                    paddingBottom: Math.max(
                                        spacing.lg,
                                        insets.bottom + spacing.md,
                                    ),
                                },
                            ]}
                        >
                            <Pressable
                                onPress={handleSubmit}
                                disabled={!canSubmit}
                                style={({ pressed }) => [
                                    styles.primaryButton,
                                    {
                                        backgroundColor: palette.accent,
                                        opacity: !canSubmit
                                            ? 0.5
                                            : pressed
                                              ? 0.85
                                              : 1,
                                    },
                                ]}
                            >
                                {submitting ? (
                                    <ActivityIndicator
                                        color={palette.textInverse}
                                    />
                                ) : (
                                    <Text
                                        style={[
                                            typography.bodyEmphasis,
                                            { color: palette.textInverse },
                                        ]}
                                    >
                                        Send feedback
                                    </Text>
                                )}
                            </Pressable>
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
    body: {
        flex: 1,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.base,
    },
    textArea: {
        // Borderless (surface fill against the page bg is the separation,
        // matching the search bars elsewhere). No resting border.
        flex: 1,
        minHeight: 140,
        borderRadius: radius.md,
        padding: spacing.md,
    },
    emailInput: {
        // Borderless at rest — borderWidth/borderColor for the error state
        // are applied inline at the field (see the email TextInput).
        height: 48,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
    },
    emailError: {
        marginTop: spacing.xs,
    },
    attachButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
    thumbRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    thumbWrap: {
        position: 'relative',
    },
    thumb: {
        width: 64,
        height: 64,
        borderRadius: radius.sm,
    },
    thumbRemove: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footer: {
        paddingBottom: spacing.lg,
    },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    confirmButton: {
        // Full-width within the centered confirm block (which uses
        // alignItems: 'center', so without this the button would shrink
        // to its label). alignSelf: 'stretch' gives the same deliberate
        // full-width primary look as the Send button.
        alignSelf: 'stretch',
    },
    confirmBlock: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        gap: spacing.base,
    },
    confirmIcon: {
        width: 64,
        height: 64,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
    confirmTitle: {
        textAlign: 'center',
    },
    confirmBody: {
        textAlign: 'center',
        marginBottom: spacing.base,
    },
});
