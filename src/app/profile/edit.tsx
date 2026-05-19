import { useRouter } from 'expo-router';
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
                {/* TEMP: text-based back affordance until react-native-svg ships in
                    the next EAS dev build. Restore <ChevronLeft color={palette.accent} size={28} />
                    (and re-add the lucide-react-native import) when lucide icons work. */}
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <Text style={[typography.bodyEmphasis, { color: palette.accent }]}>
                        ‹ Back
                    </Text>
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
