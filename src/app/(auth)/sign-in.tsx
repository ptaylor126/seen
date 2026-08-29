import { isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Image } from 'expo-image';

import { Text } from '@/components/text';
import { WORDMARK } from '@/lib/brand';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Platform,
    Pressable,
    StyleSheet,
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
    const router = useRouter();
    // Which provider's flow is in flight. Per-provider (not a boolean)
    // because iOS shows BOTH buttons: the Google button's spinner must
    // only run for the Google flow, while any in-flight flow locks both
    // buttons.
    const [busy, setBusy] = useState<'apple' | 'google' | null>(null);

    async function handleApplePress() {
        if (busy) return;
        setBusy('apple');
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
            setBusy(null);
        }
    }

    async function handleGooglePress() {
        if (busy) return;
        setBusy('google');
        try {
            await signInWithGoogle();
        } catch (err) {
            if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) {
                return;
            }
            Alert.alert('Sign-in failed', err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setBusy(null);
        }
    }

    // Shared by both platform branches: Android renders it alone (as it
    // always has), iOS renders it below the Apple button. The native
    // plumbing it needs on iOS (iosClientId here + iosUrlScheme in
    // app.json) has been in every shipped binary since May, so this is
    // pure JS.
    const googleButton = (
        <Pressable
            onPress={handleGooglePress}
            disabled={busy !== null}
            style={({ pressed }) => [
                styles.googleButton,
                {
                    // Google's LIGHT-variant button colour from
                    // the branding guidelines (#FFFFFF); pressed
                    // darkens one step to #F2F2F2. Hardcoded, not
                    // tokenised — this is Google's asset spec, it
                    // must not follow the app palette.
                    //
                    // Light, not dark: the dark variant (#131314)
                    // measured 1.03:1 against the navy ground, so
                    // the button had no visible edge and read as
                    // floating text. White is 19.09:1.
                    backgroundColor: pressed ? '#F2F2F2' : '#FFFFFF',
                    opacity: busy ? 0.6 : 1,
                },
            ]}
        >
            {busy === 'google' ? (
                // Same hardcoded Google light-variant colour as
                // the label below, and NOT palette.textInverse
                // for the same reason: that token flipped from
                // #FFFFFF (V1) to the navy #0B0D26 (V2), so it
                // tracks the app theme rather than Google's
                // asset spec. On the white button the spinner
                // must be dark or it vanishes.
                <ActivityIndicator color="#1F1F1F" />
            ) : (
                <View style={styles.googleContent}>
                    <Image
                        source={require('../../../assets/images/google-g.png')}
                        style={styles.googleLogo}
                        contentFit="contain"
                        accessibilityLabel="Google"
                    />
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            // Google's light-variant label colour.
                            // NOT palette.textInverse: that token
                            // means "text on accent fills" and
                            // flipped from #FFFFFF (V1) to the
                            // navy #0B0D26 (V2), so it follows the
                            // app theme rather than Google's asset
                            // spec. #1F1F1F reads 16.48:1 on the
                            // white button.
                            { color: '#1F1F1F' },
                        ]}
                    >
                        Sign in with Google
                    </Text>
                </View>
            )}
        </Pressable>
    );

    return (
        <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]}>
            <View style={styles.centerCluster}>
                <Image
                    source={WORDMARK}
                    style={styles.logo}
                    contentFit="contain"
                    accessibilityLabel="Seen"
                />

                {Platform.OS === 'ios' ? (
                    // Apple first: guideline 4.8 requires Sign in with
                    // Apple to remain offered, and it stays primary as the
                    // platform-native expectation. The tighter stack gap
                    // (md vs the cluster's lg) keeps the two social
                    // buttons reading as one group.
                    <View style={styles.socialStack}>
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
                        {googleButton}
                    </View>
                ) : (
                    googleButton
                )}

                {/* Quiet escape hatch to the email/password form — same
                    register as onboarding's "Have an invite link?" line.
                    Accent (the Terms/Privacy link colour), not textMuted:
                    in muted it was identical to the tagline below and read
                    as a caption, not a control. */}
                <Pressable
                    onPress={() => router.push('/(auth)/email')}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Continue with email
                    </Text>
                </Pressable>

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
    // iOS-only wrapper for the Apple + Google pair.
    socialStack: {
        gap: spacing.md,
        alignItems: 'center',
    },
    googleButton: {
        width: BUTTON_WIDTH,
        height: BUTTON_HEIGHT,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Logo + label as one centred row, mirroring the Apple button's
    // logo+label arrangement.
    googleContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    googleLogo: {
        width: 18,
        height: 18,
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
        // xl (was lg): more breathing room above the Android system nav
        // bar. The SafeAreaView above already supplies insets.bottom, so
        // this is additive to it, not a replacement — see the 2026-08-11
        // clearance audit.
        paddingBottom: spacing.xl,
    },
});
