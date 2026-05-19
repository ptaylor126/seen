import { StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPalette, typography } from '@/theme/theme';

export default function HomeScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <View style={styles.center}>
                <Text style={[typography.display, { color: palette.text }]}>Seen</Text>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
