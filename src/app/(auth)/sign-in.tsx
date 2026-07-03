import { isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
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

// Logo is 1998×587 (aspect ~3.40:1). Cap width so it doesn't dominate
// small phones or balloon on tablets; derive height from the aspect ratio.
const LOGO_ASPECT = 1998 / 587;
const LOGO_WIDTH = Math.min(240, Dimensions.get('window').width * 0.6);
const LOGO_HEIGHT = LOGO_WIDTH / LOGO_ASPECT;

// Legal docs, served from the repo's docs/ folder via GitHub Pages (same
// pages App Store Connect points at).
const TERMS_URL = 'https://ptaylor126.github.io/seen/terms.html';
const PRIVACY_URL = 'https://ptaylor126.github.io/seen/privacy.html';

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
                <Image
                    source={require('../../../assets/logo.png')}
                    style={styles.logo}
                    contentFit="contain"
                    accessibilityLabel="Seen"
                />

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
                    What to watch, from the people who{'\n'}actually know you.
                </Text>
            </View>

            <Text
                style={[
                    typography.caption,
                    styles.disclosure,
                    { color: palette.textMuted },
                ]}
            >
                By continuing, you agree to our{' '}
                {/* Nested Text spans (not Pressables) keep the links inline
                    and tappable. The line break is EXPLICIT ({'\n'} after
                    Terms) so the second line always reads "and Privacy
                    Policy." regardless of font scaling. openBrowserAsync
                    shows the in-app browser sheet instead of bouncing the
                    user out to Safari mid-sign-in. */}
                <Text
                    style={{ color: palette.accent }}
                    accessibilityRole="link"
                    onPress={() => {
                        void WebBrowser.openBrowserAsync(TERMS_URL);
                    }}
                >
                    Terms
                </Text>
                {'\n'}and{' '}
                <Text
                    style={{ color: palette.accent }}
                    accessibilityRole="link"
                    onPress={() => {
                        void WebBrowser.openBrowserAsync(PRIVACY_URL);
                    }}
                >
                    Privacy Policy
                </Text>
                .
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
    logo: {
        width: LOGO_WIDTH,
        height: LOGO_HEIGHT,
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
        // The two-line split ("…Terms" / "and Privacy Policy.") is now an
        // explicit {'\n'} in the JSX, not a wrap effect; the width cap stays
        // as a guard so huge font scaling can't push a third wrap point.
        alignSelf: 'center',
        maxWidth: BUTTON_WIDTH,
        paddingBottom: spacing.lg,
    },
});
