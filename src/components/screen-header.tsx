import { useRouter } from 'expo-router';
import {
    CaretLeft,
} from 'phosphor-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NotificationsIcon from '../../assets/images/icon-notifications.svg';
import { Text } from '@/components/text';
import { fontFamily, getPalette, radius, spacing, typography } from '@/theme/theme';

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
    /** Skip the built-in top safe-area inset. For headers rendered
     *  INSIDE a scroll container (the Library tab scrolls its header
     *  away) where the screen provides its own fixed status-bar cap —
     *  keeping the SafeAreaView here would double the inset. */
    noTopInset?: boolean;
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
    noTopInset = false,
}: ScreenHeaderProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const chromeColor = onAccent ? palette.textInverse : palette.text;

    return (
        <SafeAreaView
            edges={noTopInset ? [] : ['top']}
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
                        <CaretLeft
                            color={onAccent ? palette.textInverse : palette.accent}
                            size={28}
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
        // minHeight, not height: at 1.0 font scale nothing exceeds 36 so
        // the row is exactly 60 and the alignment above holds; at larger
        // OS font scales (clamped app-wide at 1.3, see components/text)
        // the display-size title outgrows 36 and the row must grow with
        // it rather than clip the title.
        minHeight: 36 + spacing.md * 2,
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
        // min, not fixed: the count digit scales with OS font settings (to
        // the app-wide 1.3 clamp) and must grow the circle, not clip.
        minHeight: 16,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        fontSize: 10,
        fontFamily: fontFamily.bold,
    },
});
