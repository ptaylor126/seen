import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { formatRatingStars } from '@/lib/rating';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

// One friend who watched the title. `rating` is the stored 1-10 value
// (null when they watched without rating). Same shape the title screen's
// friends-watched card is built from, so the sheet's set can't drift from
// the card's.
export interface WatcherSheetItem {
    userId: string;
    // Profile handle — the key the /friends/[handle] route navigates by
    // (tapping a row opens that friend's profile). Required for the row
    // tap; userId alone can't address the profile route.
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    rating: number | null;
}

interface WatchersSheetProps {
    visible: boolean;
    watchers: WatcherSheetItem[];
    onClose: () => void;
    // Tapping a watcher row → open their profile. The screen owns the
    // actual router.push (keeps routing out of this presentational sheet).
    onSelectWatcher: (handle: string) => void;
    // Sheet heading. Defaults to the original "Watched by"; the title
    // screen's Friends-watching card reuses this same sheet with
    // "Watching" (its rows simply have no rating — `rating: null` rows
    // already render name-only).
    title?: string;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;

// Bottom sheet listing everyone who watched a title — opened from the
// friends-watched card (which only shows the first few avatars). Standard
// bottom-sheet motion: the backdrop FADES (stationary) while the panel
// SLIDES up from the bottom — driven by one Animated value rather than
// Modal's animationType="slide" (which slides backdrop + panel together).
// The Modal stays mounted through the close animation, then unmounts.
export function WatchersSheet({
    visible,
    watchers,
    onClose,
    onSelectWatcher,
    title = 'Watched by',
}: WatchersSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    // Cap the scroll area at half the screen so a long list doesn't push
    // the sheet to full height (and the backdrop stays reachable).
    const listMaxHeight = Dimensions.get('window').height * 0.5;

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
                    <ScrollView
                        style={{ maxHeight: listMaxHeight }}
                        contentContainerStyle={styles.listContent}
                        showsVerticalScrollIndicator={false}
                    >
                        {watchers.map((w) => (
                            <Pressable
                                key={w.userId}
                                onPress={() => onSelectWatcher(w.handle)}
                                accessibilityRole="button"
                                accessibilityLabel={`View ${w.displayName}'s profile`}
                                style={({ pressed }) => [
                                    styles.row,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Avatar
                                    avatarUrl={w.avatarUrl}
                                    displayName={w.displayName}
                                    seedId={w.userId}
                                    size={40}
                                />
                                <Text
                                    style={[
                                        typography.bodyEmphasis,
                                        styles.name,
                                        { color: palette.text },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {w.displayName}
                                </Text>
                                {w.rating !== null ? (
                                    <Text
                                        style={[
                                            typography.caption,
                                            styles.rating,
                                            { color: palette.accent },
                                        ]}
                                    >
                                        {formatRatingStars(w.rating)}
                                    </Text>
                                ) : null}
                            </Pressable>
                        ))}
                    </ScrollView>
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
    listContent: {
        gap: spacing.md,
        paddingVertical: spacing.xs,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    name: {
        flex: 1,
    },
    rating: {
        // Medium weight so the stars read as a value, not body text.
        fontWeight: '500',
    },
});
