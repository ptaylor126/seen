import { isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
    useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signInWithApple, signInWithGoogle } from '@/lib/auth';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

export default function SignInScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const [busy, setBusy] = useState(false);

    async function handleApplePress() {
        if (busy) return;
        setBusy(true);
        try {
            await signInWithApple();
        } catch (err) {
            // User-cancellation throws a specific code; swallow it silently
            // so we don't surface "you cancelled" as a scary alert.
            if (err instanceof Error && 'code' in err && err.code === 'ERR_REQUEST_CANCELED') {
                return;
            }
            Alert.alert('Sign-in failed', err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setBusy(false);
        }
    }

    async function handleGooglePress() {
        if (busy) return;
        setBusy(true);
        try {
            await signInWithGoogle();
        } catch (err) {
            if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) {
                return;
            }
            Alert.alert('Sign-in failed', err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setBusy(false);
        }
    }

    return (
        <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]}>
            <View style={styles.centerCluster}>
                <Text style={[typography.display, styles.wordmark, { color: palette.text }]}>
                    Seen
                </Text>

                {Platform.OS === 'ios' ? (
                    <AppleAuthentication.AppleAuthenticationButton
                        buttonType={
                            AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
                        }
                        buttonStyle={
                            AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                        }
                        cornerRadius={radius.md}
                        style={styles.appleButton}
                        onPress={handleApplePress}
                    />
                ) : (
                    <Pressable
                        onPress={handleGooglePress}
                        disabled={busy}
                        style={({ pressed }) => [
                            styles.googleButton,
                            {
                                backgroundColor: pressed
                                    ? palette.accentPressed
                                    : palette.accent,
                                opacity: busy ? 0.6 : 1,
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
                                Sign in with Google
                            </Text>
                        )}
                    </Pressable>
                )}

                <Text
                    style={[
                        typography.caption,
                        styles.tagline,
                        { color: palette.textMuted },
                    ]}
                >
                    See what your friends are actually watching
                </Text>
            </View>

            <Text
                style={[
                    typography.caption,
                    styles.disclosure,
                    { color: palette.textMuted },
                ]}
            >
                By continuing, you agree to our Terms and Privacy Policy.
            </Text>
        </SafeAreaView>
    );
}

const BUTTON_WIDTH = 280;
const BUTTON_HEIGHT = 48;

const styles = StyleSheet.create({
    root: {
        flex: 1,
        paddingHorizontal: spacing.xl,
    },
    centerCluster: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.lg,
    },
    wordmark: {
        marginBottom: spacing.md,
    },
    appleButton: {
        width: BUTTON_WIDTH,
        height: BUTTON_HEIGHT,
    },
    googleButton: {
        width: BUTTON_WIDTH,
        height: BUTTON_HEIGHT,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tagline: {
        textAlign: 'center',
        maxWidth: 280,
    },
    disclosure: {
        textAlign: 'center',
        paddingBottom: spacing.lg,
    },
});
