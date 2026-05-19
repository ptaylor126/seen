import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPalette, spacing, typography } from '@/theme/theme';

export default function EditProfileScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

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
                    <ChevronLeft color={palette.accent} size={28} />
                </Pressable>
                <Text style={[typography.heading, { color: palette.text }]}>
                    Edit profile
                </Text>
            </View>
            <View style={styles.body}>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Coming soon
                </Text>
            </View>
        </SafeAreaView>
    );
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
    body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
