import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ProfileProvider, useProfile } from '@/hooks/use-profile';
import { useSession } from '@/hooks/use-session';
import { getPalette } from '@/theme/theme';

export default function RootLayout() {
    // ProfileProvider sits above RootLayoutInner so useProfile() inside
    // the routing effect reads from the same context the onboarding
    // screens write to via refresh(). Without the shared context, the
    // post-onboarding navigation would race against a stale profile
    // state and bounce the user back into the flow.
    return (
        <SafeAreaProvider>
            <ProfileProvider>
                <RootLayoutInner />
            </ProfileProvider>
        </SafeAreaProvider>
    );
}

function RootLayoutInner() {
    const session = useSession();
    const profile = useProfile();
    const segments = useSegments();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    // Drive routing once both the session AND the profile have resolved.
    // Three terminal states:
    //   - signed out → /(auth)/sign-in
    //   - signed in + !onboarded → /(onboarding)/welcome
    //   - signed in +  onboarded → /(tabs)
    useEffect(() => {
        if (session.status !== 'ready') return;

        const inAuthGroup = segments[0] === '(auth)';
        const inOnboardingGroup = segments[0] === '(onboarding)';

        if (!session.session) {
            if (!inAuthGroup) router.replace('/(auth)/sign-in');
            return;
        }

        // Wait for profile too — without it we don't know the onboarded
        // flag and would route the user to the wrong group.
        if (profile.status !== 'ready') return;

        const onboarded = profile.profile?.onboarded ?? false;
        if (!onboarded) {
            if (!inOnboardingGroup) router.replace('/(onboarding)/welcome');
            return;
        }
        // Onboarded: pull the user out of (auth) or (onboarding) into
        // the main app. No-op if they're already in (tabs) or any
        // pushed modal route.
        if (inAuthGroup || inOnboardingGroup) {
            router.replace('/(tabs)');
        }
    }, [session, profile, segments, router]);

    const showLoading =
        session.status === 'loading' ||
        (!!session.session && profile.status === 'loading');

    return (
        <>
            <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen
                    name="title/[mediaType]/[tmdbId]"
                    options={{ presentation: 'modal' }}
                />
                <Stack.Screen
                    name="title/[mediaType]/[tmdbId]/recommend"
                    options={{ presentation: 'modal' }}
                />
                <Stack.Screen
                    name="library/add"
                    options={{ presentation: 'modal' }}
                />
            </Stack>
            {showLoading && (
                <View style={[styles.loadingOverlay, { backgroundColor: palette.bg }]}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            )}
        </>
    );
}

const styles = StyleSheet.create({
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
