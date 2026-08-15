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
import {
    button,
    fontFamily,
    getPalette,
    spacing,
    THEME_V2_ENABLED,
    typography,
} from '@/theme/theme';

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

// Fixed-width slot the icon is centred in. Users and Play have different
// ink widths, so rendering them bare started the text at a different x on
// each row — the ragged edge. A constant-width slot makes the text start
// at the same x regardless of glyph. 28 clears the 20pt glyph with 4pt
// either side; invisible (no fill, no border), purely a measuring box.
const SUPPORT_ICON_SLOT = 28;

// The headline reads in two weights at one size: a light opening that
// sets up the claim, then the bold payoff. Both at typography.display
// (32pt); only the face differs.
//
// The light face is named directly rather than taken from a theme token
// because there is no light DISPLAY token — theme.ts exposes only
// DISPLAY_FACE_BOLD/SEMIBOLD. Guarded on THEME_V2_ENABLED so V1, which
// renders the display tier in Geist and never loads Bricolage, falls back
// to its own regular face instead of a family it can't resolve.
const HEADLINE_LIGHT_FACE = THEME_V2_ENABLED
    ? 'BricolageGrotesque_300Light'
    : fontFamily.default;

const HEADLINE_PART_LIGHT = 'People who know your taste,';
const HEADLINE_PART_BOLD = 'showing you what to watch';

// ONE continuous word list across both weight parts. The cascade indexes
// into this array, so the 60 ms stagger runs unbroken straight through the
// weight change rather than restarting at the bold part. Trailing space on
// every word except the very last gives natural inter-word spacing in the
// flex-wrap row without `gap` (which would double-up on wrapped lines).
interface HeadlineWord {
    word: string;
    light: boolean;
}
const HEADLINE_WORDS: readonly HeadlineWord[] = [
    // Every light word keeps its trailing space — the bold part follows it.
    ...HEADLINE_PART_LIGHT.split(' ').map((word) => ({
        word: `${word} `,
        light: true,
    })),
    ...HEADLINE_PART_BOLD.split(' ').map((word, i, all) => ({
        word: i === all.length - 1 ? word : `${word} `,
        light: false,
    })),
];

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
    light,
}: {
    word: string;
    index: number;
    progress: SharedValue<number>;
    color: string;
    // Renders the light face instead of the display tier's bold one.
    // Size/lineHeight still come from typography.display either way.
    light: boolean;
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
        <Animated.Text
            style={[
                typography.display,
                light && { fontFamily: HEADLINE_LIGHT_FACE },
                { color },
                style,
            ]}
        >
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
                    {HEADLINE_WORDS.map((entry, i) => (
                        <AnimatedWord
                            key={i}
                            word={entry.word}
                            index={i}
                            progress={headlineProgress}
                            color={palette.text}
                            light={entry.light}
                        />
                    ))}
                </View>

                {/* Two support lines, icon left of text, arriving as one
                    block in the slot the old subtext occupied. */}
                <Animated.View style={[styles.support, supportStyle]}>
                    <View style={styles.supportRow}>
                        <View style={styles.supportIconSlot}>
                            <Users
                                color={palette.accent}
                                size={SUPPORT_ICON_SIZE}
                            />
                        </View>
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
                        <View style={styles.supportIconSlot}>
                            <Play
                                color={palette.accent}
                                size={SUPPORT_ICON_SIZE}
                            />
                        </View>
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
        // Centred as a BLOCK, left-aligned WITHIN it. alignSelf:'center'
        // sizes the block to its widest row (287pt — measured, fits the
        // 343pt content width of an SE) and centres it under the
        // headline; the rows then stretch to that block width by the
        // column default, so both icons share a left edge instead of
        // each row centring independently and staggering them.
        alignSelf: 'center',
        // Rows stay tight (sm/8) so the two benefits read as one pair.
        gap: spacing.sm,
        // Extra separation from the headline ON TOP of the body's own
        // gap.lg, making headline→support 48pt against the 8pt row gap —
        // without it the 24pt gap sat close enough to the row gap that
        // the pitch and the benefits read as one continuous block. Set
        // here rather than raising body.gap because that single gap also
        // governs logo→headline, which is correctly 24.
        marginTop: spacing.lg,
    },
    supportRow: {
        flexDirection: 'row',
        // Centres the icon slot against its text line.
        alignItems: 'center',
        // Slot-to-text gap. Unchanged (sm/8) — the slot absorbs the
        // per-glyph width difference, so this stays a constant.
        gap: spacing.sm,
    },
    supportIconSlot: {
        // Invisible fixed-width measuring box (see SUPPORT_ICON_SLOT).
        // No fill/border by design — alignment only.
        width: SUPPORT_ICON_SLOT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    supportText: {
        // shrink (not flex:1): flex:1 would force each row to fill the
        // block, defeating the content-sizing that centring depends on.
        // shrink still lets the text wrap under large font scaling.
        flexShrink: 1,
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
