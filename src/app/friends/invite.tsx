import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    Share,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import supabase from '@/lib/supabase';
import {
    button,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// `seen.app` is a placeholder domain — we don't own it yet. When a real
// domain is registered, the Universal Link / App Link plumbing (apple-app-
// site-association on iOS, intent filters on Android) needs to be wired
// up so taps on this URL open the app and call claim_invite_link(token).
// For now this is just a display string + share payload — it won't deep-
// link into the app yet.
const INVITE_URL_BASE = 'https://seen.app/invite/';

export default function InviteLinkScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [regenBusy, setRegenBusy] = useState(false);

    useEffect(() => {
        let active = true;

        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const userId = session?.user.id;
                if (!userId) throw new Error('Not authenticated');

                const { data, error: queryError } = await supabase
                    .from('invite_links')
                    .select('token')
                    .eq('user_id', userId)
                    .single();
                if (queryError) throw queryError;
                if (!active) return;
                setToken(data.token);
            } catch (err) {
                if (!active) return;
                console.error('invite link fetch failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load invite link');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, []);

    const url = token ? `${INVITE_URL_BASE}${token}` : '';

    async function handleCopy() {
        if (!url) return;
        await Clipboard.setStringAsync(url);
        Alert.alert('Copied', 'Invite link copied to clipboard.');
    }

    async function handleShare() {
        if (!url) return;
        try {
            await Share.share({ message: url });
        } catch (err) {
            console.error('share failed:', err);
        }
    }

    async function handleRegenerate() {
        Alert.alert(
            'Regenerate invite link?',
            'The old link will stop working. Anyone you sent it to will need a new one.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Regenerate',
                    style: 'destructive',
                    onPress: () => regenerateNow(),
                },
            ],
        );
    }

    async function regenerateNow() {
        if (regenBusy) return;
        setRegenBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const { data: newToken, error: rpcError } = await supabase.rpc(
                'generate_invite_token',
            );
            if (rpcError) throw rpcError;
            if (typeof newToken !== 'string') {
                throw new Error('Token generation returned no value');
            }

            const { error: updateError } = await supabase
                .from('invite_links')
                .update({ token: newToken })
                .eq('user_id', userId);
            if (updateError) throw updateError;

            setToken(newToken);
        } catch (err) {
            console.error('regenerate failed:', err);
            surfaceError(err, 'Regenerate failed');
        } finally {
            setRegenBusy(false);
        }
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
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
                <Text style={[typography.heading, { color: palette.text }]}>
                    Your invite link
                </Text>
            </View>

            <View style={styles.body}>
                <Text
                    style={[styles.intro, typography.body, { color: palette.textMuted }]}
                >
                    Share this link with friends so they can add you. Anyone who taps it
                    will become your friend automatically.
                </Text>

                {loading ? (
                    <ActivityIndicator color={palette.accent} style={styles.spinner} />
                ) : error ? (
                    <Text style={[typography.body, { color: palette.error }]}>{error}</Text>
                ) : (
                    <>
                        <View
                            style={[
                                styles.urlBox,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: palette.border,
                                },
                            ]}
                        >
                            <Text
                                style={[typography.body, { color: palette.text }]}
                                selectable
                                numberOfLines={1}
                                ellipsizeMode="middle"
                            >
                                {url}
                            </Text>
                        </View>

                        <View style={styles.actions}>
                            <Pressable
                                onPress={handleCopy}
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
                                    Copy link
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={handleShare}
                                style={({ pressed }) => [
                                    styles.secondaryButton,
                                    {
                                        borderColor: palette.accent,
                                        opacity: pressed ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        { color: palette.accent },
                                    ]}
                                >
                                    Share
                                </Text>
                            </Pressable>
                        </View>

                        <Pressable
                            onPress={handleRegenerate}
                            disabled={regenBusy}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [
                                styles.regenLink,
                                { opacity: pressed || regenBusy ? 0.6 : 1 },
                            ]}
                        >
                            <Text style={[typography.body, { color: palette.textMuted }]}>
                                Regenerate link
                            </Text>
                        </Pressable>
                    </>
                )}
            </View>
        </SafeAreaView>
    );
}

function surfaceError(err: unknown, title: string) {
    if (err && typeof err === 'object' && 'message' in err) {
        const supaErr = err as {
            message: string;
            details?: string;
            hint?: string;
            code?: string;
        };
        Alert.alert(
            title,
            `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
        );
    } else {
        Alert.alert(title, String(err));
    }
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    body: {
        flex: 1,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.lg,
    },
    intro: {
        lineHeight: 22,
    },
    spinner: {
        marginTop: spacing.xl,
    },
    urlBox: {
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    primaryButton: {
        flex: 1,
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    secondaryButton: {
        flex: 1,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    regenLink: {
        alignSelf: 'center',
        paddingVertical: spacing.sm,
    },
});
