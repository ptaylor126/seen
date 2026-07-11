import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NotificationsIcon from '../../assets/images/icon-notifications.svg';
import { getPalette, ICON_STROKE_WIDTH, spacing, typography } from '@/theme/theme';

interface ScreenHeaderProps {
    title?: string;
    /** Custom content for the left/title slot, rendered in place of the
     *  string `title` (e.g. Home's logo wordmark). When provided, `title`
     *  is ignored. Lets a screen reuse this header's bell + safe-area +
     *  padding while supplying its own left element. */
    leading?: ReactNode;
    showBackButton?: boolean;
    /** Hide unread badge when 0; show "9+" for >9. */
    unreadCount?: number;
    /** Suppress the right-side bell. Useful on the inbox screen itself so
     *  the icon doesn't link back to the same place. */
    hideBell?: boolean;
    /** Extra right-side actions rendered before the Mail bell. */
    rightActions?: ReactNode;
    /** Renders the header on a plum (accent) background with inverse
     *  chrome — title, back chevron, and bell go white; the unread badge
     *  flips to white-on-plum so it doesn't vanish accent-on-accent. Used
     *  by the profile screens' plum banner headers. */
    onAccent?: boolean;
}

export function ScreenHeader({
    title,
    leading,
    showBackButton = false,
    unreadCount = 0,
    hideBell = false,
    rightActions,
    onAccent = false,
}: ScreenHeaderProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const chromeColor = onAccent ? palette.textInverse : palette.text;

    return (
        <SafeAreaView
            edges={['top']}
            style={{
                backgroundColor: onAccent ? palette.accent : palette.bg,
            }}
        >
            <View style={styles.bar}>
                {showBackButton && (
                    <Pressable
                        onPress={() => router.back()}
                        hitSlop={spacing.sm}
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                        <ChevronLeft
                            color={onAccent ? palette.textInverse : palette.accent}
                            size={28}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    </Pressable>
                )}

                {leading ? (
                    <View style={styles.title}>{leading}</View>
                ) : title ? (
                    <Text
                        style={[typography.display, styles.title, { color: chromeColor }]}
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
                                    color={chromeColor}
                                    width={26}
                                    height={26}
                                />
                                {unreadCount > 0 && (
                                    <View
                                        style={[
                                            styles.badge,
                                            {
                                                backgroundColor: onAccent
                                                    ? palette.textInverse
                                                    : palette.accent,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.badgeText,
                                                {
                                                    color: onAccent
                                                        ? palette.accent
                                                        : palette.textInverse,
                                                },
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
        // Deterministic row height so the inbox bell sits at the same Y on
        // EVERY tab, by construction rather than by coincidence of element
        // metrics. Measured at runtime: a title Text (typography.display,
        // lineHeight 38) renders only ~36px tall on iOS, while Home's 38px
        // logo box filled 38 — so the rows were 60 vs 62 and the bell
        // centred 2px lower on Home. Pinning the content region to 36 (RN
        // border-box: height 60 − paddingVertical 12×2 = 36 content) makes
        // all four tabs a fixed 60px. The logo is capped at 36 (see
        // index.tsx headerLogo) so nothing exceeds the content region.
        height: 36 + spacing.md * 2,
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
