import { useRouter } from 'expo-router';
import {
    CaretLeft,
} from 'phosphor-react-native';
import { useEffect } from 'react';
import {
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import Animated, {
    Easing,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClaimInvite } from '@/components/claim-invite';
import { Text } from '@/components/text';
import { useProfile } from '@/hooks/use-profile';
import { shareInvite } from '@/lib/invite';
import { finishOnboarding } from '@/lib/onboarding-utils';
import {
    button,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Benefit-line entrance — same single-shared-value cascade shape as
// welcome.tsx's headline word cascade (AnimatedWord there): ONE linear
// driver (benefitsProgress, 0→1 across the whole cascade) rather than a
// shared-value pair per line, so each BenefitLine maps its own index to a
// time-slice and applies its own ease-out inside useAnimatedStyle. See
// welcome.tsx's header comment for why a per-line pair doesn't scale.
const BENEFIT_LINES = [
    'See what your friends are watching',
    'Send and receive recs',
    'Read their reviews and ratings',
] as const;
// ~100ms-scale stagger between lines (vs welcome's 60ms for single words —
// a full line carries more visual weight, so it earns a slightly longer
// gap). 400ms per line to resolve, matching welcome's per-word/per-block
// duration. A short 300ms head start (no logo here to wait on, unlike
// welcome — just a beat so the cascade doesn't fire the instant the screen
// appears).
const BENEFITS_START_MS = 300;
const BENEFITS_STAGGER_MS = 100;
const BENEFIT_MS = 400;
const BENEFITS_TOTAL_MS =
    (BENEFIT_LINES.length - 1) * BENEFITS_STAGGER_MS + BENEFIT_MS;
// The instruction line — the closer — lands as a single block once the
// benefit cascade settles, same "support lines land after the headline"
// shape welcome.tsx uses for its own closing block. ~200ms gap after the
// cascade visually finishes, matching welcome's beat-between-blocks feel.
const INSTRUCTION_START_MS = BENEFITS_START_MS + BENEFITS_TOTAL_MS + 200;
const INSTRUCTION_MS = 400;

// One benefit line — a small accent check + the line text, both painted
// inside the SAME animated container so they fade (opacity 0→1) + rise
// (translateY 8→0) as one unit — the check is part of the line's entrance,
// not a separately-timed element. Eased with the same inlined
// ease-out-cubic welcome.tsx's AnimatedWord uses (the driver runs linearly;
// each line eases itself, worklet-safe).
function BenefitLine({
    text,
    index,
    progress,
    color,
    checkColor,
}: {
    text: string;
    index: number;
    progress: SharedValue<number>;
    color: string;
    checkColor: string;
}) {
    const style = useAnimatedStyle(() => {
        const start = (index * BENEFITS_STAGGER_MS) / BENEFITS_TOTAL_MS;
        const end =
            (index * BENEFITS_STAGGER_MS + BENEFIT_MS) / BENEFITS_TOTAL_MS;
        const raw = (progress.value - start) / (end - start);
        const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        const eased = 1 - Math.pow(1 - t, 3);
        return {
            opacity: eased,
            transform: [{ translateY: 8 * (1 - eased) }],
        };
    });
    return (
        <Animated.View style={[styles.benefitRow, style]}>
            {/* Small, quiet functional marker — plain body weight (not
                bodyEmphasis), so it reads as a list bullet, not a second
                accent element competing with the filled Invite button
                below. Text colour stays muted; only the check is accent. */}
            <Text style={[typography.body, { color: checkColor }]}>✓</Text>
            <Text style={[typography.body, { color }]}>{text}</Text>
        </Animated.View>
    );
}

// Final onboarding screen — friends-first. Seen's value is recommendations
// from people you actually trust, so this asks the user to bring a couple of
// them in before they land in the app, rather than framing it as "grow our
// app". Optional: a clearly-visible "Skip for now" sits secondary to the
// invite action, and BOTH paths call finishOnboarding (the onboarded flip
// moved here from currently-watching), so either way onboarding completes and
// the root layout redirects to /(tabs).
export default function InviteScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { profile, refresh: refreshProfile } = useProfile();

    // The user's own handle, set back in handle.tsx, injected so friends can
    // add them straight away. Defensive fallback if the profile somehow
    // hasn't propagated (it always has by this step).
    const handle = profile?.handle ?? null;
    const pitch = handle
        ? `I'm using Seen to swap film & TV recs — get it and add me, I'm @${handle}.`
        : `I'm using Seen to swap film & TV recs — get it and add me.`;

    // Entrance motion — the headline is present from the start (no logo
    // beat to follow here, unlike welcome.tsx); the benefit lines cascade
    // in, then the instruction line (the closer) lands last as its own
    // block. See the constants above for the exact timing.
    const benefitsProgress = useSharedValue(0);
    const instructionOpacity = useSharedValue(0);
    const instructionTranslateY = useSharedValue(8);

    useEffect(() => {
        const eo = Easing.out(Easing.cubic);

        // Benefit cascade — LINEAR across the whole window so the lines
        // start evenly spaced; each line applies its own ease-out inside
        // BenefitLine. Same shape as welcome.tsx's headline cascade driver.
        benefitsProgress.value = withDelay(
            BENEFITS_START_MS,
            withTiming(1, {
                duration: BENEFITS_TOTAL_MS,
                easing: Easing.linear,
            }),
        );

        // Instruction line lands as a single block after the cascade
        // settles — the final beat, the closer.
        instructionOpacity.value = withDelay(
            INSTRUCTION_START_MS,
            withTiming(1, { duration: INSTRUCTION_MS, easing: eo }),
        );
        instructionTranslateY.value = withDelay(
            INSTRUCTION_START_MS,
            withTiming(0, { duration: INSTRUCTION_MS, easing: eo }),
        );
    }, [benefitsProgress, instructionOpacity, instructionTranslateY]);

    const instructionStyle = useAnimatedStyle(() => ({
        opacity: instructionOpacity.value,
        transform: [{ translateY: instructionTranslateY.value }],
    }));

    async function finish() {
        await finishOnboarding({ refreshProfile });
    }

    async function handleInvite() {
        // shareInvite shares the user's TOKENIZED seenrecs.com/i/ link (the
        // landing page + claim auto-friend both sides) with this screen's
        // handle-carrying pitch. Onboarding completes unconditionally once
        // the share sheet has been offered, REGARDLESS of whether the OS
        // reports it as sent, cancelled, or dismissed — Share can't
        // reliably tell "sent" from "cancelled" on iOS, so gating on that
        // signal made inviting strictly HARDER than tapping "Skip for now"
        // (which always advances): backing out of the sheet dead-ended the
        // user on this screen instead. The invite moment is high-value
        // precisely because it's the LAST screen before the app opens —
        // trapping the user here on an ambiguous or failed share actively
        // works against that, since Friends/Home keep offering the same
        // invite after onboarding (see friends.tsx, index.tsx, add.tsx).
        await shareInvite(pitch);
        await finish();
    }

    async function handleSkip() {
        await finish();
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top', 'bottom']}
        >
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <CaretLeft
                        color={palette.accent}
                        size={28}
                    />
                </Pressable>
            </View>

            <View style={styles.body}>
                <Text style={[typography.display, { color: palette.text }]}>
                    Seen works best with friends
                </Text>
                {/* The why, beneath the ask — quiet, unhyped, spaced lines
                    rather than bullet characters (a listicle reads as
                    marketing, not the app's voice). No exclamation marks.
                    This is onboarding, not a pitch: three lines max.
                    Cascades in — see BenefitLine + the timing constants
                    above. */}
                <View style={styles.benefits}>
                    {BENEFIT_LINES.map((line, i) => (
                        <BenefitLine
                            key={line}
                            text={line}
                            index={i}
                            progress={benefitsProgress}
                            color={palette.textMuted}
                            checkColor={palette.accent}
                        />
                    ))}
                </View>
                {/* The concrete, personal ask — one line, slightly
                    emphasised (full-strength text, not muted) against the
                    quieter benefit lines above it. Deliberately NOT bold/
                    accent: BRANDING.md reserves those for actionable
                    elements, and this line isn't the action — the button
                    below is. Full-strength colour alone is enough lift.
                    Lands last, as its own block, once the cascade settles
                    (instructionStyle — see the timing constants above).
                    Explicit line break at the clause boundary (same
                    technique as sign-in.tsx's tagline) rather than an
                    estimated maxWidth — the natural wrap stranded "with."
                    alone on its own line; a maxWidth guess could still do
                    that at a different screen width or font scale, an
                    explicit break can't. */}
                <Animated.Text
                    style={[
                        typography.body,
                        styles.instruction,
                        { color: palette.text },
                        instructionStyle,
                    ]}
                >
                    Send it to the person{'\n'}you always swap recs with.
                </Animated.Text>
            </View>

            <View style={styles.footer}>
                <Pressable
                    onPress={handleInvite}
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
                        Invite a friend
                    </Text>
                </Pressable>
                <Pressable
                    onPress={handleSkip}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.skipButton,
                        { opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        Skip for now
                    </Text>
                </Pressable>

                {/* Quiet, skippable claim path for someone who INSTALLED
                    from a rec invite link (seenrecs.com/r/). Claiming
                    creates the friendship + the rec server-side; here we
                    complete onboarding and land them on the rec that
                    brought them. The rec id rides INTO (tabs) as a route
                    param and home pushes it once mounted — no timer. The
                    root layout's onboarded-redirect may also fire, but
                    both replaces target (tabs): if ours runs first the
                    effect no-ops (segments already out of onboarding);
                    if the effect wins, ours follows to the same route
                    carrying the param. Either order converges. */}
                <ClaimInvite
                    onClaimed={(target) => {
                        void (async () => {
                            await finish();
                            router.replace({
                                pathname: '/(tabs)',
                                params:
                                    target.type === 'rec'
                                        ? { claimedRec: target.recId }
                                        : { claimedFriend: target.userId },
                            });
                        })();
                    }}
                />
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: { paddingVertical: spacing.sm },
    // Heading vertically centered (gap removed with the body text — the
    // heading is the block's only child now); the footer is pushed to the
    // bottom by body's flex: 1.
    body: { flex: 1, justifyContent: 'center' },
    benefits: {
        marginTop: spacing.lg,
        gap: spacing.xs,
    },
    benefitRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    // The concrete-ask line, given the same lg beat below the benefits
    // that separates the benefits block from the headline above it.
    instruction: {
        marginTop: spacing.lg,
    },
    footer: { gap: spacing.sm, paddingBottom: spacing.md },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
