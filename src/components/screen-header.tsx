import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NotificationsIcon from '../../assets/images/icon-notifications.svg';
import { getPalette, ICON_STROKE_WIDTH, spacing, typography } from '@/theme/theme';

interface ScreenHeaderProps {
    title?: string;
    showBackButton?: boolean;
    /** Hide unread badge when 0; show "9+" for >9. */
    unreadCount?: number;
    /** Suppress the right-side bell. Useful on the inbox screen itself so
     *  the icon doesn't link back to the same place. */
    hideBell?: boolean;
    /** Extra right-side actions rendered before the Mail bell. */
    rightActions?: ReactNode;
}

export function ScreenHeader({
    title,
    showBackButton = false,
    unreadCount = 0,
    hideBell = false,
    rightActions,
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

                {title ? (
                    <Text
                        style={[typography.display, styles.title, { color: palette.text }]}
                        numberOfLines={1}
                    >
                        {title}
                    </Text>
                ) : (
                    <View style={styles.title} />
                )}

                <View style={styles.rightCluster}>
                    {rightActions}
                    {!hideBell && (
                        <Pressable
                            onPress={() => router.push('/inbox')}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <View>
                                <NotificationsIcon
                                    color={palette.text}
                                    width={24}
                                    height={24}
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
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        gap: spacing.sm,
    },
    title: {
        flex: 1,
    },
    rightCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.base,
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
