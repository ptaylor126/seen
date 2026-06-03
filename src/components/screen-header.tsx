import { useRouter } from 'expo-router';
import { ChevronLeft, Mail } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPalette, ICON_STROKE_WIDTH, spacing, typography } from '@/theme/theme';

interface ScreenHeaderProps {
    title?: string;
    showBackButton?: boolean;
    /** Hide unread badge when 0; show "9+" for >9. */
    unreadCount?: number;
    /** Suppress the right-side bell. Useful on the inbox screen itself so
     *  the icon doesn't link back to the same place. */
    hideBell?: boolean;
}

const HEADER_HEIGHT = 44;

export function ScreenHeader({
    title,
    showBackButton = false,
    unreadCount = 0,
    hideBell = false,
}: ScreenHeaderProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();

    return (
        <SafeAreaView
            edges={['top']}
            style={{ backgroundColor: palette.bg }}
        >
            <View style={styles.bar}>
                <View style={styles.side}>
                    {showBackButton && (
                        <Pressable
                            onPress={() => router.back()}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <ChevronLeft
                                color={palette.accent}
                                size={28}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    )}
                </View>

                <View style={styles.center}>
                    {title ? (
                        <Text
                            style={[typography.heading, { color: palette.text }]}
                            numberOfLines={1}
                        >
                            {title}
                        </Text>
                    ) : null}
                </View>

                <View style={[styles.side, styles.sideEnd]}>
                    {!hideBell && (
                        <Pressable
                            onPress={() => router.push('/inbox')}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <View>
                                <Mail
                                    color={palette.text}
                                    size={24}
                                    strokeWidth={ICON_STROKE_WIDTH}
                                />
                                {unreadCount > 0 && (
                                    <View
                                        style={[
                                            styles.badge,
                                            { backgroundColor: palette.accent },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.badgeText,
                                                { color: palette.textInverse },
                                            ]}
                                        >
                                            {unreadCount > 9
                                                ? '9+'
                                                : String(unreadCount)}
                                        </Text>
                                    </View>
                                )}
                            </View>
                        </Pressable>
                    )}
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    bar: {
        height: HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
    },
    side: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    sideEnd: {
        justifyContent: 'flex-end',
    },
    center: {
        flex: 2,
        alignItems: 'center',
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -6,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        fontSize: 10,
        fontWeight: '700',
    },
});
