import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { Fragment, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Linking,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { signOut } from '@/lib/auth';
import supabase from '@/lib/supabase';
import { getPalette, ICON_STROKE_WIDTH, spacing, typography } from '@/theme/theme';

interface ProfileData {
    handle: string;
    display_name: string;
    avatar_url: string | null;
}

const AVATAR_SIZE = 96;

export default function ProfileScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const { count: unreadCount } = useUnreadCount();

    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

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
                    .from('profiles')
                    .select('handle, display_name, avatar_url')
                    .eq('id', userId)
                    .single();

                if (queryError) throw queryError;
                if (!active) return;
                setProfile(data);
            } catch (err) {
                if (!active) return;
                console.error('profile fetch failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load profile');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, []);

    async function handleSignOut() {
        try {
            await signOut();
            // useSession's onAuthStateChange subscription flips to ready/null,
            // root layout's useEffect redirects to /(auth)/sign-in.
        } catch (err) {
            console.error('sign out failed:', err);
            Alert.alert(
                'Sign out failed',
                err instanceof Error ? err.message : 'Unknown error',
            );
        }
    }

    function confirmSignOut() {
        Alert.alert('Sign out of Seen?', undefined, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign out', style: 'destructive', onPress: handleSignOut },
        ]);
    }

    // Build a mailto: with blank space at the top of the body for the
    // tester to write freely; device + app version sit below a `---`
    // separator as a footer. The previous structured-prompt template
    // (I was doing / What happened / What I expected) felt prescriptive
    // — a blank canvas + footer reads more like "tell me anything."
    // Falls back to a plain alert if no mail client is configured.
    async function handleSendFeedback() {
        const appVersion = Constants.expoConfig?.version ?? 'unknown';
        const deviceLabel =
            Platform.OS === 'ios'
                ? `iOS ${Platform.Version}`
                : `Android API ${Platform.Version}`;
        const subject = 'Seen feedback';
        // Four leading newlines drop the cursor onto a blank area; the
        // separator + footer sit below the user's drafting space.
        const body = `\n\n\n\n---\nDevice: ${deviceLabel}\nApp version: ${appVersion}`;
        const url = `mailto:thisispaultaylor@icloud.com?subject=${encodeURIComponent(
            subject,
        )}&body=${encodeURIComponent(body)}`;

        try {
            const canOpen = await Linking.canOpenURL(url);
            if (!canOpen) {
                Alert.alert(
                    'No mail app found',
                    'Please email feedback to thisispaultaylor@icloud.com directly.',
                );
                return;
            }
            await Linking.openURL(url);
        } catch (err) {
            console.warn('open mailto failed:', err);
            Alert.alert(
                'No mail app found',
                'Please email feedback to thisispaultaylor@icloud.com directly.',
            );
        }
    }

    const rows: Array<{ id: string; label: string; onPress: () => void }> = [
        {
            id: 'edit',
            label: 'Edit profile',
            onPress: () => router.push('/profile/edit'),
        },
        {
            id: 'feedback',
            label: 'Send feedback',
            onPress: handleSendFeedback,
        },
        {
            id: 'account',
            label: 'Account',
            onPress: () => router.push('/profile/account'),
        },
        { id: 'signout', label: 'Sign out', onPress: confirmSignOut },
    ];

    if (loading) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader title="Profile" unreadCount={unreadCount} />
                <View style={styles.fillCenter}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            </View>
        );
    }

    if (error || !profile) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader title="Profile" unreadCount={unreadCount} />
                <View style={styles.fillCenter}>
                    <Text style={[typography.body, { color: palette.error }]}>
                        {error ?? 'Profile not available'}
                    </Text>
                </View>
            </View>
        );
    }

    const firstLetter = profile.display_name[0]?.toUpperCase() ?? '?';

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Profile" unreadCount={unreadCount} />
            <View style={styles.card}>
                {profile.avatar_url ? (
                    <Image
                        source={{ uri: profile.avatar_url }}
                        style={[styles.avatar, { backgroundColor: palette.accent }]}
                        contentFit="cover"
                        transition={200}
                    />
                ) : (
                    <View
                        style={[
                            styles.avatar,
                            styles.avatarFallback,
                            { backgroundColor: palette.accent },
                        ]}
                    >
                        <Text style={[typography.display, { color: palette.textInverse }]}>
                            {firstLetter}
                        </Text>
                    </View>
                )}
                <Text
                    style={[typography.display, styles.displayName, { color: palette.text }]}
                >
                    {profile.display_name}
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    @{profile.handle}
                </Text>
            </View>

            <View>
                {rows.map((row, i) => (
                    <Fragment key={row.id}>
                        {i > 0 && (
                            <View
                                style={[styles.separator, { backgroundColor: palette.border }]}
                            />
                        )}
                        <Pressable
                            onPress={row.onPress}
                            style={({ pressed }) => [
                                styles.settingsRow,
                                pressed && { opacity: 0.6 },
                            ]}
                        >
                            <Text
                                style={[
                                    typography.body,
                                    styles.settingsLabel,
                                    { color: palette.text },
                                ]}
                            >
                                {row.label}
                            </Text>
                            <ChevronRight
                                color={palette.textMuted}
                                size={20}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    </Fragment>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    card: {
        alignItems: 'center',
        gap: spacing.sm,
        paddingTop: spacing.xl,
        paddingBottom: spacing.xl,
        paddingHorizontal: spacing.base,
    },
    avatar: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
    },
    avatarFallback: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    displayName: {
        marginTop: spacing.md,
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.base,
    },
    settingsLabel: { flex: 1 },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: spacing.base,
    },
});
