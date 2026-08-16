import { useRouter } from 'expo-router';
import {
    CaretLeft,
} from 'phosphor-react-native';
import {
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClaimInvite } from '@/components/claim-invite';
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

    async function finish() {
        await finishOnboarding({ refreshProfile });
    }

    async function handleInvite() {
        // shareInvite shares the user's TOKENIZED seenrecs.com/i/ link (the
        // landing page + claim auto-friend both sides) with this screen's
        // handle-carrying pitch, and returns true only on an explicit share.
        // Complete onboarding ONLY on that clear share: Share can't reliably
        // tell "sent" from "cancelled" on iOS, so a dismissal leaves the
        // user here to retry or tap "Skip for now" deliberately. The invite
        // moment is high-value; better to occasionally keep someone here
        // than to boot them out on an accidental cancel.
        const shared = await shareInvite(pitch);
        if (shared) {
            await finish();
        }
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
                    Invite the friends you share recs with
                </Text>
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
