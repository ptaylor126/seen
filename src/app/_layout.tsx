import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSession } from '@/hooks/use-session';
import { getPalette } from '@/theme/theme';

export default function RootLayout() {
    const session = useSession();
    const segments = useSegments();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    // Drive routing once the session has resolved. Two cases handled:
    //   - signed out + outside (auth) group  → redirect to sign-in
    //   - signed in  + inside  (auth) group  → redirect home (e.g. after login)
    useEffect(() => {
        if (session.status !== 'ready') return;

        const inAuthGroup = segments[0] === '(auth)';

        if (!session.session && !inAuthGroup) {
            router.replace('/(auth)/sign-in');
        } else if (session.session && inAuthGroup) {
            router.replace('/(tabs)');
        }
    }, [session, segments, router]);

    return (
        <SafeAreaProvider>
            <Stack screenOptions={{ headerShown: false }} />
            {session.status === 'loading' && (
                <View style={[styles.loadingOverlay, { backgroundColor: palette.bg }]}>
                    <ActivityIndicator color={palette.accent} />
                </View>
            )}
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
