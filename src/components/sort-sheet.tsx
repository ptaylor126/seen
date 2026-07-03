import { Check } from 'lucide-react-native';
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

import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Custom bottom sheet for the library sort picker (shared by the own-library
// tab and the friend library via LibraryFilterControls). Replaces the native
// menus after both misbehaved: Alert.alert stacked Cancel indistinguishably
// among the options, and ActionSheetIOS presented as a centered popover WITH
// NO CANCEL on a plain iPhone (not the bottom-sheet-with-detached-Cancel it
// documents). Building on the app's own sheet pattern gives full control:
// options with a checkmark on the active sort, and a clearly separated,
// heavier-weight Cancel below the list.
//
// Motion is copied from WatchersSheet/RatingSheet: the backdrop FADES
// (stationary) while the panel SLIDES up — one Animated value, Modal kept
// mounted through the close animation.

export interface SortSheetOption<T extends string> {
    value: T;
    label: string;
}

interface SortSheetProps<T extends string> {
    visible: boolean;
    title?: string;
    options: ReadonlyArray<SortSheetOption<T>>;
    selectedValue: T;
    // Called with the tapped option; the caller owns applying the sort AND
    // closing the sheet (keeps this component purely presentational).
    onSelect: (value: T) => void;
    onClose: () => void;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;

export function SortSheet<T extends string>({
    visible,
    title = 'Sort by',
    options,
    selectedValue,
    onSelect,
    onClose,
}: SortSheetProps<T>) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    // Keep the Modal mounted while the close animation plays.
    const [mounted, setMounted] = useState(visible);
    // 0 = closed (backdrop transparent, panel off-screen), 1 = open.
    const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
    // Panel height drives the slide distance; falls back to a tall value
    // until first onLayout so the panel starts fully off-screen.
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
                if (finished) setMounted(false);
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
                {/* Backdrop: fades only, never moves. */}
                <AnimatedPressable
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: palette.overlay, opacity: progress },
                    ]}
                    onPress={onClose}
                />
                {/* Panel: slides up; sits on top of the backdrop so taps on
                    it don't fall through to the dismiss. */}
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
                        {title}
                    </Text>
                    {options.map((opt) => {
                        const active = opt.value === selectedValue;
                        return (
                            <Pressable
                                key={opt.value}
                                onPress={() => onSelect(opt.value)}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`Sort by ${opt.label}`}
                                style={({ pressed }) => [
                                    styles.optionRow,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Text
                                    style={[
                                        active
                                            ? typography.bodyEmphasis
                                            : typography.body,
                                        styles.optionLabel,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {opt.label}
                                </Text>
                                {active && (
                                    <Check
                                        color={palette.accent}
                                        size={18}
                                        strokeWidth={ICON_STROKE_WIDTH}
                                    />
                                )}
                            </Pressable>
                        );
                    })}
                    {/* Cancel — visually DETACHED from the options: a clear
                        gap above (the whole point of leaving the native
                        menus) and a heavier weight so it reads as the
                        dismiss action, not another choice. No bright
                        colour by design. */}
                    <Pressable
                        onPress={onClose}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                        style={({ pressed }) => [
                            styles.cancelRow,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.text },
                            ]}
                        >
                            Cancel
                        </Text>
                    </Pressable>
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
    },
    title: {
        textAlign: 'center',
        marginBottom: spacing.base,
    },
    optionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: spacing.md,
    },
    optionLabel: {
        flexShrink: 1,
    },
    cancelRow: {
        // The detachment: a full spacing.lg break above Cancel separates it
        // from the option list; centred + semibold (bodyEmphasis) marks it
        // as the way out rather than the seventh option.
        marginTop: spacing.lg,
        alignItems: 'center',
        paddingVertical: spacing.sm,
    },
});
