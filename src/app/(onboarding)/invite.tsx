import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import {
    Platform,
    Pressable,
    Share,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useProfile } from '@/hooks/use-profile';
import { finishOnboarding } from '@/lib/onboarding-utils';
import {
    getPalette,
    ICON_STROKE_WIDTH,
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
const APP_STORE_URL = 'https://apps.apple.com/app/id6775920785';

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
        try {
            // iOS: link as a separate `url` item → rich App Store preview in
            // the share sheet. Android ignores `url`, so the link goes inline
            // in the message there. Mirrors friends/add.tsx.
            const result = await Share.share(
                Platform.OS === 'ios'
                    ? { message: pitch, url: APP_STORE_URL }
                    : { message: `${pitch} ${APP_STORE_URL}` },
            );
            // Complete onboarding ONLY on a clear share. Share.share can't
            // reliably tell "sent" from "cancelled" on iOS, so anything that
            // isn't an explicit sharedAction — dismissedAction, or an
            // ambiguous/undefined result — leaves the user on this screen to
            // retry or tap "Skip for now" deliberately. The invite moment is
            // high-value; better to occasionally keep someone here than to
            // boot them out on an accidental cancel.
            if (result?.action === Share.sharedAction) {
                await finish();
            }
        } catch (err) {
            // Sheet failed to open / rejected — stay on the screen.
            console.error('onboarding invite share failed:', err);
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
                    <ChevronLeft
                        color={palette.accent}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
            </View>

            <View style={styles.body}>
                <Text style={[typography.display, { color: palette.text }]}>
                    Bring the people whose taste you trust
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Add a couple now so your friends can start sending you
                    things worth watching.
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
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: { paddingVertical: spacing.sm },
    // Content vertically centered; the footer is pushed to the bottom by
    // body's flex: 1.
    body: { flex: 1, justifyContent: 'center', gap: spacing.md },
    footer: { gap: spacing.sm, paddingBottom: spacing.md },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
