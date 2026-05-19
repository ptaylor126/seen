import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { getPalette, typography } from '@/theme/theme';

export default function HomeScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const { count: unreadCount } = useUnreadCount();

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader unreadCount={unreadCount} />
            <View style={styles.center}>
                <Text style={[typography.display, { color: palette.text }]}>Seen</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
