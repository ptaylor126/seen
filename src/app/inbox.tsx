import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { getPalette, typography } from '@/theme/theme';

export default function InboxScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Inbox" showBackButton hideBell />
            <View style={styles.body}>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Coming soon
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
