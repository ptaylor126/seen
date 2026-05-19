import { StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPalette, spacing, typography } from '@/theme/theme';

export default function LibraryScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]} edges={['top']}>
            <View style={styles.center}>
                <Text style={[typography.display, { color: palette.text }]}>Library</Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>Coming soon</Text>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
});
