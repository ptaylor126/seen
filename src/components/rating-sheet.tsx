import * as Haptics from 'expo-haptics';
import { Star, StarHalf } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    Modal,
    PanResponder,
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

interface RatingSheetProps {
    visible: boolean;
    busy: boolean;
    // Pre-fill the stars with an existing rating. The rating is stored
    // on the half-star 1-10 scale (1 = ½★, 2 = 1★, …, 10 = 5★). Null
    // means no pre-selection.
    initialRating: number | null;
    // Called with the chosen 1-10 rating when the user taps Done, or
    // null when they dismissed without committing (Skip, backdrop tap,
    // hardware back).
    onSubmit: (rating: number | null) => void;
}

const STAR_COUNT = 5;
const HALF_COUNT = STAR_COUNT * 2; // = 10
// Distance (in px) the finger must travel before the row-level
// PanResponder claims the gesture from the per-half Pressables.
// Below: a tap, the Pressable handles it. Above: a drag.
const DRAG_THRESHOLD_PX = 5;

// Bottom-sheet open/close motion: backdrop fades while the panel slides
// (see the animation effect below). Standard pattern, replacing Modal's
// animationType="slide" (which slid backdrop + panel as one unit).
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const OPEN_MS = 240;
const CLOSE_MS = 180;

type StarVariant = 'empty' | 'half' | 'full';

// Map a (1-based) star slot + the current 1-10 rating to its visual
// variant. Star N is full when rating >= N * 2, half when rating ==
// N * 2 - 1, otherwise empty. Null rating → all empty.
function getStarVariant(starIndex: number, rating: number | null): StarVariant {
    if (rating === null) return 'empty';
    if (rating >= starIndex * 2) return 'full';
    if (rating === starIndex * 2 - 1) return 'half';
    return 'empty';
}

// Map a row-relative X coordinate to a 1-10 rating. Each star occupies
// rowWidth/STAR_COUNT pixels; left half maps to (starIndex*2 - 1),
// right half to starIndex*2. Out-of-range coordinates clamp to the
// nearest endpoint — drag past the rightmost star pins to 10, drag
// before the first half pins to 1. (Deselect-to-null lives on the
// tap-toggle path; drag never produces 0.)
function valueFromRowX(localX: number, rowWidth: number): number {
    if (rowWidth <= 0) return 1;
    const halfWidth = rowWidth / HALF_COUNT;
    const idx = Math.floor(localX / halfWidth);
    return Math.max(1, Math.min(HALF_COUNT, idx + 1));
}

// Bottom-sheet star rating prompt used after a Watched transition.
// Caller controls visible / busy / initialRating; the sheet owns
// (a) the tentative selection the user is building toward Done and
// (b) the press-in fill preview that lights stars while the finger
// is down.
export function RatingSheet({
    visible,
    busy,
    initialRating,
    onSubmit,
}: RatingSheetProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Keep the Modal mounted while the close animation plays.
    const [mounted, setMounted] = useState(visible);
    // 0 = closed (backdrop transparent, panel off-screen), 1 = open.
    const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
    // Panel height drives the slide distance; tall fallback until first
    // onLayout so the panel starts fully off-screen.
    const [sheetHeight, setSheetHeight] = useState(
        Dimensions.get('window').height,
    );
    // Tentative selection — committed only when Done is pressed.
    // Tapping the same half-star value a second time deselects it.
    const [selected, setSelected] = useState<number | null>(initialRating);
    // Press-in preview — lights stars while the user holds. Clears on
    // press-out so the display falls back to `selected`.
    const [pressedRating, setPressedRating] = useState<number | null>(null);
    // Measured row width — set via onLayout. Drives the X→value mapping.
    const [rowWidth, setRowWidth] = useState(0);

    // Refs mirror state for the PanResponder closures: the responder is
    // created once via useRef, so its handlers can't close over the
    // latest state values.
    const rowRef = useRef<View>(null);
    const rowWidthRef = useRef(0);
    const rowPageXRef = useRef(0);
    const pressedRatingRef = useRef<number | null>(null);
    // Which value last triggered a haptic. Drag haptics fire once per
    // transition into a new half-star value rather than on every move
    // event.
    const lastHapticValueRef = useRef<number | null>(null);

    useEffect(() => {
        rowWidthRef.current = rowWidth;
    }, [rowWidth]);
    useEffect(() => {
        pressedRatingRef.current = pressedRating;
    }, [pressedRating]);

    // Resync internal state to the prop each time the sheet opens.
    useEffect(() => {
        if (visible) {
            setSelected(initialRating);
            setPressedRating(null);
            lastHapticValueRef.current = null;
        }
    }, [visible, initialRating]);

    // Open/close motion: backdrop fades + panel slides off ONE value.
    // Stay mounted through the close animation, then unmount.
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

    // Captures both the row's width and its absolute page-X position
    // (via measure()). pageX is required to translate the gesture's
    // moveX (screen coords) into row-relative coordinates — onLayout
    // alone only gives parent-relative offsets.
    function handleRowLayout() {
        rowRef.current?.measure((_x, _y, w, _h, pageX) => {
            setRowWidth(w);
            rowPageXRef.current = pageX;
        });
    }

    // Row-level drag gesture. Quick taps still go through the per-half
    // Pressables (onStartShouldSet returns false); only crossing the
    // DRAG_THRESHOLD_PX claims the responder for drag-to-rate.
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, g) =>
                Math.abs(g.dx) > DRAG_THRESHOLD_PX ||
                Math.abs(g.dy) > DRAG_THRESHOLD_PX,
            onPanResponderGrant: (_, g) => {
                const localX = g.x0 - rowPageXRef.current;
                const value = valueFromRowX(localX, rowWidthRef.current);
                setPressedRating(value);
                if (lastHapticValueRef.current !== value) {
                    lastHapticValueRef.current = value;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
            },
            onPanResponderMove: (_, g) => {
                const localX = g.moveX - rowPageXRef.current;
                const value = valueFromRowX(localX, rowWidthRef.current);
                setPressedRating(value);
                if (lastHapticValueRef.current !== value) {
                    lastHapticValueRef.current = value;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
            },
            onPanResponderRelease: () => {
                const committed = pressedRatingRef.current;
                setPressedRating(null);
                lastHapticValueRef.current = null;
                if (committed !== null) setSelected(committed);
            },
            onPanResponderTerminate: () => {
                setPressedRating(null);
                lastHapticValueRef.current = null;
            },
        }),
    ).current;

    function handleHalfPressIn(value: number) {
        setPressedRating(value);
        // Share the haptic-tracker with the PanResponder so its
        // onPanResponderGrant doesn't re-fire a haptic for this value.
        lastHapticValueRef.current = value;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    function handleHalfPress(value: number) {
        // Tap-toggle: same value a second time clears the selection.
        setSelected((curr) => (curr === value ? null : value));
    }

    function handleDone() {
        onSubmit(selected);
    }

    function handleSkip() {
        onSubmit(null);
    }

    // Stars fill from the pressed preview first; when not pressing,
    // fall back to the committed selection.
    const effectiveRating = pressedRating ?? selected;
    const doneDisabled = busy || selected === null;

    return (
        <Modal
            visible={mounted}
            transparent
            animationType="none"
            onRequestClose={handleSkip}
        >
            <View style={styles.backdrop}>
                {/* Backdrop: fades only, never moves. */}
                <AnimatedPressable
                    style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: palette.overlay, opacity: progress },
                    ]}
                    onPress={handleSkip}
                />
                {/* Panel: slides up; on top of the backdrop so taps on it
                    don't fall through to dismiss. */}
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
                        How was it?
                    </Text>
                    <View
                        ref={rowRef}
                        onLayout={handleRowLayout}
                        style={styles.starsRow}
                        {...panResponder.panHandlers}
                    >
                        {[1, 2, 3, 4, 5].map((starIndex) => {
                            const variant = getStarVariant(starIndex, effectiveRating);
                            const leftValue = starIndex * 2 - 1;
                            const rightValue = starIndex * 2;
                            const iconColor =
                                variant === 'empty'
                                    ? palette.textMuted
                                    : palette.accent;
                            return (
                                <View key={starIndex} style={styles.starCell}>
                                    {/* The visual layer renders behind the
                                        tap overlays; pointerEvents:none on
                                        the style so finger events fall
                                        through to the Pressable halves. */}
                                    <View style={styles.starVisual}>
                                        {variant === 'full' ? (
                                            <Star
                                                color={iconColor}
                                                fill={palette.accent}
                                                size={36}
                                                strokeWidth={ICON_STROKE_WIDTH}
                                            />
                                        ) : variant === 'half' ? (
                                            // StarHalf fills the left side
                                            // only; the right side is
                                            // outlined by an underlying
                                            // empty Star at the same
                                            // position to keep the full
                                            // star silhouette intact.
                                            <View style={styles.starStack}>
                                                <Star
                                                    color={palette.textMuted}
                                                    fill="transparent"
                                                    size={36}
                                                    strokeWidth={ICON_STROKE_WIDTH}
                                                />
                                                <View style={styles.halfOverlay}>
                                                    <StarHalf
                                                        color={palette.accent}
                                                        fill={palette.accent}
                                                        size={36}
                                                        strokeWidth={
                                                            ICON_STROKE_WIDTH
                                                        }
                                                    />
                                                </View>
                                            </View>
                                        ) : (
                                            <Star
                                                color={palette.textMuted}
                                                fill="transparent"
                                                size={36}
                                                strokeWidth={ICON_STROKE_WIDTH}
                                            />
                                        )}
                                    </View>
                                    {/* Two tap zones overlaid on each
                                        star — left half writes the odd
                                        ½-star value, right half writes
                                        the even whole-star value. */}
                                    <Pressable
                                        onPressIn={() =>
                                            handleHalfPressIn(leftValue)
                                        }
                                        onPressOut={() => setPressedRating(null)}
                                        onPress={() => handleHalfPress(leftValue)}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                            styles.halfHit,
                                            styles.halfLeft,
                                            { opacity: pressed || busy ? 0.6 : 1 },
                                        ]}
                                    />
                                    <Pressable
                                        onPressIn={() =>
                                            handleHalfPressIn(rightValue)
                                        }
                                        onPressOut={() => setPressedRating(null)}
                                        onPress={() => handleHalfPress(rightValue)}
                                        disabled={busy}
                                        style={({ pressed }) => [
                                            styles.halfHit,
                                            styles.halfRight,
                                            { opacity: pressed || busy ? 0.6 : 1 },
                                        ]}
                                    />
                                </View>
                            );
                        })}
                    </View>
                    <Pressable
                        onPress={handleDone}
                        disabled={doneDisabled}
                        style={({ pressed }) => [
                            styles.doneButton,
                            {
                                backgroundColor: palette.accent,
                                opacity: doneDisabled ? 0.4 : pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textInverse },
                            ]}
                        >
                            Done
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={handleSkip}
                        disabled={busy}
                        style={({ pressed }) => [
                            styles.skipButton,
                            { opacity: pressed || busy ? 0.6 : 1 },
                        ]}
                    >
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.textMuted },
                            ]}
                        >
                            Skip
                        </Text>
                    </Pressable>
                </Animated.View>
            </View>
        </Modal>
    );
}

const STAR_CELL_SIZE = 44;

const styles = StyleSheet.create({
    backdrop: {
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
        marginBottom: spacing.lg,
    },
    starsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        // alignSelf shrinks the row to content width so onLayout reports
        // just the stars+gaps span — required for the drag-gesture
        // value mapping to line up with the visible stars.
        alignSelf: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.sm,
    },
    starCell: {
        width: STAR_CELL_SIZE,
        height: STAR_CELL_SIZE,
        // relative wrapper; visual + two tap zones overlay inside.
    },
    starVisual: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
    },
    starStack: {
        width: 36,
        height: 36,
    },
    halfOverlay: {
        ...StyleSheet.absoluteFillObject,
    },
    halfHit: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: STAR_CELL_SIZE / 2,
    },
    halfLeft: {
        left: 0,
    },
    halfRight: {
        right: 0,
    },
    doneButton: {
        alignSelf: 'center',
        marginTop: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.sm,
    },
});
