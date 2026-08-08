import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import { fontFamily, button, getPalette, radius, spacing, typography } from '@/theme/theme';

const logoSource = require('../../../assets/logo.png');

// ---------------------------------------------------------------------------
// Animation choreography. One marquee moment — the Seen logo tunes in
// like an old CRT, then the screen resolves in a staggered cascade:
// per-word headline → subtext → button. Times below are start offsets
// from mount; total sequence ~2.6s.
//
//   t=0     logo enters (scale 0.3 → 1 spring; rotate 5° → 0;
//           opacity 0.3 → 1) — settles around t=800 ms
//   t=800   word 1 of headline fades + slides in (translateY 8 → 0)
//   t=920   word 2 (stagger = 120 ms between word starts)
//   t=1040  word 3
//   t=1160  word 4
//   t=1280  word 5; last word settles around t=1680 ms
//   t=1800  subtext fades + slides in
//   t=2300  Get started button fades + scales 0.95 → 1
// ---------------------------------------------------------------------------
const LOGO_TIMING_MS = 700;        // rotation/opacity duration (spring drives scale)
const HEADLINE_START_MS = 800;
const HEADLINE_STAGGER_MS = 120;
const WORD_MS = 400;
const SUBTEXT_START_MS = 1800;
const SUBTEXT_MS = 400;
const BUTTON_START_MS = 2300;
const BUTTON_MS = 300;

// Five words, each animated independently. Trailing space on every
// word except the last gives natural inter-word spacing in the
// flex-wrap row without relying on `gap` (which would visually
// double-up when a word breaks to a new line).
const HEADLINE_WORDS: readonly string[] = [
    'Recs ',
    'from ',
    'people ',
    'you ',
    'trust.',
];

export default function WelcomeScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    // Logo shared values. Initial state: small + slightly rotated +
    // low opacity. Opacity at 0.3 (not actual blur) suggests
    // "unfocus" without requiring a blur filter at runtime.
    const logoScale = useSharedValue(0.3);
    const logoRotate = useSharedValue(5);
    const logoOpacity = useSharedValue(0.3);

    // Per-word shared values. Five words → five pairs. useSharedValue
    // must be called the same way every render, so they're declared
    // explicitly rather than via map().
    const w0Opacity = useSharedValue(0);
    const w1Opacity = useSharedValue(0);
    const w2Opacity = useSharedValue(0);
    const w3Opacity = useSharedValue(0);
    const w4Opacity = useSharedValue(0);
    const w0Y = useSharedValue(8);
    const w1Y = useSharedValue(8);
    const w2Y = useSharedValue(8);
    const w3Y = useSharedValue(8);
    const w4Y = useSharedValue(8);

    const subtextOpacity = useSharedValue(0);
    const subtextTranslateY = useSharedValue(8);

    const buttonOpacity = useSharedValue(0);
    const buttonScale = useSharedValue(0.95);

    useEffect(() => {
        const eo = Easing.out(Easing.cubic);

        // Logo: spring on scale gives a snappy settle with a hint of
        // overshoot (damping 12 / stiffness 180 / mass 0.9 ≈ 800 ms
        // to rest, ~one tight bounce). Rotation and opacity ride a
        // matched ease-out timing so the three properties land
        // together rather than the spring oscillating past the
        // timing's already-finished glide.
        logoScale.value = withSpring(1, {
            damping: 12,
            stiffness: 180,
            mass: 0.9,
        });
        logoRotate.value = withTiming(0, {
            duration: LOGO_TIMING_MS,
            easing: eo,
        });
        logoOpacity.value = withTiming(1, {
            duration: LOGO_TIMING_MS,
            easing: eo,
        });

        // Headline words — staggered start, identical 400 ms duration.
        const wOpacities = [w0Opacity, w1Opacity, w2Opacity, w3Opacity, w4Opacity];
        const wYs = [w0Y, w1Y, w2Y, w3Y, w4Y];
        for (let i = 0; i < HEADLINE_WORDS.length; i++) {
            const delay = HEADLINE_START_MS + i * HEADLINE_STAGGER_MS;
            wOpacities[i].value = withDelay(
                delay,
                withTiming(1, { duration: WORD_MS, easing: eo }),
            );
            wYs[i].value = withDelay(
                delay,
                withTiming(0, { duration: WORD_MS, easing: eo }),
            );
        }

        // Subtext lands as a single block after the headline settles.
        subtextOpacity.value = withDelay(
            SUBTEXT_START_MS,
            withTiming(1, { duration: SUBTEXT_MS, easing: eo }),
        );
        subtextTranslateY.value = withDelay(
            SUBTEXT_START_MS,
            withTiming(0, { duration: SUBTEXT_MS, easing: eo }),
        );

        // Button last. Scale 0.95 → 1 reads as "lifting in" rather
        // than just fading; combined with opacity this is the
        // standard "I'm interactive now" cue.
        buttonOpacity.value = withDelay(
            BUTTON_START_MS,
            withTiming(1, { duration: BUTTON_MS, easing: eo }),
        );
        buttonScale.value = withDelay(
            BUTTON_START_MS,
            withTiming(1, { duration: BUTTON_MS, easing: eo }),
        );
    }, [
        buttonOpacity,
        buttonScale,
        logoOpacity,
        logoRotate,
        logoScale,
        subtextOpacity,
        subtextTranslateY,
        w0Opacity,
        w0Y,
        w1Opacity,
        w1Y,
        w2Opacity,
        w2Y,
        w3Opacity,
        w3Y,
        w4Opacity,
        w4Y,
    ]);

    const logoStyle = useAnimatedStyle(() => ({
        opacity: logoOpacity.value,
        transform: [
            { scale: logoScale.value },
            { rotate: `${logoRotate.value}deg` },
        ],
    }));

    const w0Style = useAnimatedStyle(() => ({
        opacity: w0Opacity.value,
        transform: [{ translateY: w0Y.value }],
    }));
    const w1Style = useAnimatedStyle(() => ({
        opacity: w1Opacity.value,
        transform: [{ translateY: w1Y.value }],
    }));
    const w2Style = useAnimatedStyle(() => ({
        opacity: w2Opacity.value,
        transform: [{ translateY: w2Y.value }],
    }));
    const w3Style = useAnimatedStyle(() => ({
        opacity: w3Opacity.value,
        transform: [{ translateY: w3Y.value }],
    }));
    const w4Style = useAnimatedStyle(() => ({
        opacity: w4Opacity.value,
        transform: [{ translateY: w4Y.value }],
    }));
    const wordStyles = [w0Style, w1Style, w2Style, w3Style, w4Style];

    const subtextStyle = useAnimatedStyle(() => ({
        opacity: subtextOpacity.value,
        transform: [{ translateY: subtextTranslateY.value }],
    }));

    const buttonStyle = useAnimatedStyle(() => ({
        opacity: buttonOpacity.value,
        transform: [{ scale: buttonScale.value }],
    }));

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top', 'bottom']}
        >
            <OnboardingProgress currentStep={1} totalSteps={4} />
            <View style={styles.body}>
                <Animated.View style={[styles.logoWrap, logoStyle]}>
                    <Image
                        source={logoSource}
                        style={styles.logo}
                        contentFit="contain"
                        // Cached on first render. Keep the transition
                        // off so the image's appearance is driven
                        // entirely by our Animated.View parent.
                        transition={0}
                    />
                </Animated.View>

                <View style={styles.headlineRow}>
                    {HEADLINE_WORDS.map((word, i) => (
                        <Animated.Text
                            key={i}
                            style={[
                                typography.hero,
                                { color: palette.text },
                                wordStyles[i],
                            ]}
                        >
                            {word}
                        </Animated.Text>
                    ))}
                </View>

                <Animated.Text
                    style={[
                        styles.subtext,
                        { color: palette.textMuted },
                        subtextStyle,
                    ]}
                >
                    Three things and you&apos;re ready.
                </Animated.Text>
            </View>

            <Animated.View style={[styles.footer, buttonStyle]}>
                <Pressable
                    onPress={() => router.push('/(onboarding)/handle')}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Get started
                    </Text>
                </Pressable>
            </Animated.View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    body: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: spacing.lg,
    },
    logoWrap: {
        marginBottom: spacing.md,
    },
    logo: {
        // Source asset is 500 × 147 (≈ 3.4:1). 200 wide is ~50% of an
        // iPhone 15 width — prominent without being overwhelming.
        width: 200,
        height: 59,
    },
    headlineRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        // No gap — each word carries its own trailing space (see
        // HEADLINE_WORDS) so wrapping reads natural.
    },
    subtext: {
        fontSize: 18,
        fontFamily: fontFamily.medium,
        lineHeight: 26,
        textAlign: 'center',
    },
    footer: {
        paddingBottom: spacing.md,
    },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
