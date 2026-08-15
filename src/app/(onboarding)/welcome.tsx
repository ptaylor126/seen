import { Image } from 'expo-image';

import { WORDMARK } from '@/lib/brand';
import { useRouter } from 'expo-router';
import { Play, Users } from 'phosphor-react-native';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import Animated, {
    Easing,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import { button, getPalette, spacing, typography } from '@/theme/theme';

const logoSource = WORDMARK;

// ---------------------------------------------------------------------------
// Animation choreography. One marquee moment — the Seen logo tunes in
// like an old CRT, then the screen resolves in a staggered cascade:
// per-word headline → support lines → button. Times below are start
// offsets from mount; total sequence ~2.7s.
//
//   t=0     logo enters (scale 0.3 → 1 spring; rotate 5° → 0;
//           opacity 0.3 → 1) — settles around t=800 ms
//   t=800   headline cascade starts; word N begins at 800 + N×60 ms,
//           each word taking 400 ms. Last of 12 words settles ~t=1860
//   t=1900  support lines fade + slide in as one block
//   t=2400  Get started button fades + scales 0.95 → 1
//
// The headline cascade is driven by ONE shared value (headlineProgress,
// 0 → 1 across the whole cascade) rather than a pair of shared values
// per word. The previous shape hand-declared five opacity/translateY
// pairs — "five words → five pairs" — because hooks can't be called
// from a map(). That capped the headline at exactly five words: a sixth
// read `wordStyles[5] === undefined` and rendered instantly at full
// opacity while its siblings cascaded. Deriving each word's window from
// a single driver inside <AnimatedWord> (its own component, so its
// hooks run unconditionally) makes the word count arbitrary.
// ---------------------------------------------------------------------------
const LOGO_TIMING_MS = 700;        // rotation/opacity duration (spring drives scale)
const HEADLINE_START_MS = 800;
const HEADLINE_STAGGER_MS = 60;
const WORD_MS = 400;
const SUPPORT_START_MS = 1900;
const SUPPORT_MS = 400;
const BUTTON_START_MS = 2400;
const BUTTON_MS = 300;

// Support-line icon size — 20 sits just under the 16pt body text's
// cap height, so the glyph reads as a peer of the text, not a bullet.
const SUPPORT_ICON_SIZE = 20;

// Trailing space on every word except the last gives natural inter-word
// spacing in the flex-wrap row without relying on `gap` (which would
// visually double-up when a word breaks to a new line).
//
// Rendered at typography.display (32pt Bricolage Bold) this wraps to 3
// lines on every current device class (measured against the real font
// metrics: SE 375pt → 3, iPhone 15 393pt → 3, Pro Max 430pt → 3).
const HEADLINE = 'The people who know what you like, telling you what to watch';
const HEADLINE_WORDS: readonly string[] = HEADLINE.split(' ').map(
    (word, i, all) => (i === all.length - 1 ? word : `${word} `),
);

// Total cascade duration — the last word STARTS at (n-1)×stagger and
// runs for WORD_MS. headlineProgress spans this whole window, so each
// word's slice below is expressed as a fraction of it.
const HEADLINE_TOTAL_MS =
    (HEADLINE_WORDS.length - 1) * HEADLINE_STAGGER_MS + WORD_MS;

// One word of the headline. Its own component so useAnimatedStyle is
// called unconditionally per instance — which is what legitimises the
// map() in the parent. Reads the SHARED cascade driver and derives its
// own 400 ms window from `index`.
function AnimatedWord({
    word,
    index,
    progress,
    color,
}: {
    word: string;
    index: number;
    progress: SharedValue<number>;
    color: string;
}) {
    const style = useAnimatedStyle(() => {
        const start = (index * HEADLINE_STAGGER_MS) / HEADLINE_TOTAL_MS;
        const end =
            (index * HEADLINE_STAGGER_MS + WORD_MS) / HEADLINE_TOTAL_MS;
        // Local 0→1 within this word's slice of the cascade.
        const raw = (progress.value - start) / (end - start);
        const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        // Ease-out cubic, inlined rather than imported: the driver runs
        // linearly so the per-word easing has to happen here, and this
        // is the worklet-safe form of Easing.out(Easing.cubic).
        const eased = 1 - Math.pow(1 - t, 3);
        return {
            opacity: eased,
            transform: [{ translateY: 8 * (1 - eased) }],
        };
    });

    return (
        <Animated.Text style={[typography.display, { color }, style]}>
            {word}
        </Animated.Text>
    );
}

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

    // The single headline cascade driver (see the header comment).
    const headlineProgress = useSharedValue(0);

    const supportOpacity = useSharedValue(0);
    const supportTranslateY = useSharedValue(8);

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

        // Headline cascade — LINEAR across the whole window so the words
        // start evenly spaced; each word applies its own ease-out inside
        // AnimatedWord. (Easing the driver instead would bunch the
        // stagger.)
        headlineProgress.value = withDelay(
            HEADLINE_START_MS,
            withTiming(1, {
                duration: HEADLINE_TOTAL_MS,
                easing: Easing.linear,
            }),
        );

        // Support lines land as a single block after the headline settles.
        supportOpacity.value = withDelay(
            SUPPORT_START_MS,
            withTiming(1, { duration: SUPPORT_MS, easing: eo }),
        );
        supportTranslateY.value = withDelay(
            SUPPORT_START_MS,
            withTiming(0, { duration: SUPPORT_MS, easing: eo }),
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
        headlineProgress,
        logoOpacity,
        logoRotate,
        logoScale,
        supportOpacity,
        supportTranslateY,
    ]);

    const logoStyle = useAnimatedStyle(() => ({
        opacity: logoOpacity.value,
        transform: [
            { scale: logoScale.value },
            { rotate: `${logoRotate.value}deg` },
        ],
    }));

    const supportStyle = useAnimatedStyle(() => ({
        opacity: supportOpacity.value,
        transform: [{ translateY: supportTranslateY.value }],
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
                        <AnimatedWord
                            key={i}
                            word={word}
                            index={i}
                            progress={headlineProgress}
                            color={palette.text}
                        />
                    ))}
                </View>

                {/* Two support lines, icon left of text, arriving as one
                    block in the slot the old subtext occupied. */}
                <Animated.View style={[styles.support, supportStyle]}>
                    <View style={styles.supportRow}>
                        <Users color={palette.accent} size={SUPPORT_ICON_SIZE} />
                        <Text
                            style={[
                                typography.body,
                                styles.supportText,
                                { color: palette.textMuted },
                            ]}
                        >
                            See what your friends are watching
                        </Text>
                    </View>
                    <View style={styles.supportRow}>
                        <Play color={palette.accent} size={SUPPORT_ICON_SIZE} />
                        <Text
                            style={[
                                typography.body,
                                styles.supportText,
                                { color: palette.textMuted },
                            ]}
                        >
                            Never scroll for an hour again
                        </Text>
                    </View>
                </Animated.View>
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
    support: {
        // Left-aligned as a block (not centred like the headline): the
        // two icons need a shared left edge or the rows read ragged.
        alignSelf: 'stretch',
        gap: spacing.sm,
    },
    supportRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    supportText: {
        // flex so a long line wraps under itself rather than pushing
        // the row wider than the screen.
        flex: 1,
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
