import { Alert, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signOut } from '@/lib/auth';
import { getPalette, spacing, typography } from '@/theme/theme';

export default function HomeScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    async function handleSignOut() {
        try {
            await signOut();
        } catch (err) {
            Alert.alert('Sign-out failed', err instanceof Error ? err.message : 'Unknown error');
        }
    }

    return (
        <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]}>
            <View style={styles.center}>
                <Text style={[typography.display, { color: palette.text }]}>Seen</Text>

                {/* TEMP: will move to profile/settings screen in PRD §4 */}
                <Pressable
                    onPress={handleSignOut}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [styles.signOut, { opacity: pressed ? 0.6 : 1 }]}
                >
                    <Text style={[typography.body, { color: palette.accent }]}>Sign out</Text>
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
    signOut: { padding: spacing.base },
});
