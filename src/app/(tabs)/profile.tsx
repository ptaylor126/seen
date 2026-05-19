import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { Fragment, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
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
import { getPalette, spacing, typography } from '@/theme/theme';

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

    const rows: Array<{ id: string; label: string; onPress: () => void }> = [
        {
            id: 'edit',
            label: 'Edit profile',
            onPress: () => router.push('/profile/edit'),
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
                            <ChevronRight color={palette.textMuted} size={20} />
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
