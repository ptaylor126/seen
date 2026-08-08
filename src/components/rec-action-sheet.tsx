import {
    Check,
} from 'phosphor-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type ItemStatus } from '@/lib/item-status';
import {
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface RecActionSheetProps {
    visible: boolean;
    // The user's current library status for this title (selected row gets a
    // check). null = not in their library yet.
    currentStatus: ItemStatus | null;
    busy: boolean;
    onClose: () => void;
    onPickStatus: (status: ItemStatus) => void;
    // Fired once the close animation has finished and the sheet is fully
    // unmounted. The rec view uses this to present the rating sheet only
    // after this modal is gone — presenting a second modal while this one
    // is still dismissing is silently dropped on iOS.
    onClosed?: () => void;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;

const STATUS_OPTIONS: { value: ItemStatus; label: string }[] = [
    { value: 'watchlist', label: 'Watchlist' },
    { value: 'watching', label: 'Watching' },
    { value: 'watched', label: 'Watched' },
];

// Status sheet for a recommendation: set library status (watchlist /
// watching / watched). "Not for me" is its own button on the rec view, so
// it's intentionally NOT in here. Same presentation as the rating /
// watchers / decline sheets — backdrop fades (stationary) while the panel
// slides up, and the Modal stays mounted through the close animation.
export function RecActionSheet({
    visible,
    currentStatus,
    busy,
    onClose,
    onPickStatus,
    onClosed,
}: RecActionSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    const [mounted, setMounted] = useState(visible);
    const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );

    useEffect(() => {
        if (visible) {
            setMounted(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: OPEN_MS,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }).start();
        } else {
            Animated.timing(progress, {
                toValue: 0,
                duration: CLOSE_MS,
                easing: Easing.in(Easing.cubic),
                useNativeDriver: true,
            }).start(({ finished }) => {
                if (finished) {
                    setMounted(false);
                    // Sheet is fully unmounted now — safe for the parent to
                    // present a follow-up modal (the rating sheet) without
                    // colliding with this one's dismissal.
                    onClosed?.();
                }
            });
        }
    }, [visible, progress]);

    const translateY = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [sheetHeight, 0],
    });

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            onRequestClose={onClose}
        >
            <View style={styles.container}>
                <AnimatedPressable
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: palette.overlay, opacity: progress },
                    ]}
                    onPress={onClose}
                />
                <Animated.View
                    onLayout={(e) =>
                        setSheetHeight(e.nativeEvent.layout.height)
                    }
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: palette.surface,
                            paddingBottom: insets.bottom + spacing.lg,
                            transform: [{ translateY }],
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.heading,
                            styles.title,
                            { color: palette.text },
                        ]}
                    >
                        Save to your library
                    </Text>

                    {STATUS_OPTIONS.map((opt) => {
                        const selected = currentStatus === opt.value;
                        return (
                            <Pressable
                                key={opt.value}
                                onPress={() => onPickStatus(opt.value)}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityState={{ selected }}
                                accessibilityLabel={opt.label}
                                style={({ pressed }) => [
                                    styles.row,
                                    {
                                        backgroundColor: selected
                                            ? palette.accentWash
                                            : palette.bg,
                                        opacity: pressed || busy ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        styles.rowLabel,
                                        {
                                            color: selected
                                                ? palette.accent
                                                : palette.text,
                                        },
                                    ]}
                                >
                                    {opt.label}
                                </Text>
                                {/* Check pinned to the right so the label
                                    stays horizontally centered in the pill. */}
                                {selected ? (
                                    <View style={styles.rowCheck}>
                                        <Check
                                            color={palette.accent}
                                            size={18}
                                        />
                                    </View>
                                ) : null}
                            </Pressable>
                        );
                    })}
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        paddingHorizontal: spacing.base,
        paddingTop: spacing.lg,
        gap: spacing.sm,
    },
    title: {
        textAlign: 'center',
        marginBottom: spacing.sm,
    },
    row: {
        // Center the label in the pill; the check is absolutely positioned
        // at the right edge so it doesn't pull the label off-center.
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        borderRadius: radius.md,
    },
    rowLabel: {
        textAlign: 'center',
    },
    rowCheck: {
        position: 'absolute',
        right: spacing.base,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
    },
});
