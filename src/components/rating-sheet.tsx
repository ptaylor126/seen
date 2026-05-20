import * as Haptics from 'expo-haptics';
import { Star } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
    Modal,
    PanResponder,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPalette, radius, spacing, typography } from '@/theme/theme';

interface RatingSheetProps {
    visible: boolean;
    busy: boolean;
    // Pre-fill the stars with an existing rating (e.g. re-rating a
    // previously-watched title). Null = no pre-selection.
    initialRating: number | null;
    // Called with the chosen 1-5 rating when the user taps Done, or
    // null when they dismissed without committing (Skip, backdrop tap,
    // hardware back).
    onSubmit: (rating: number | null) => void;
}

const STAR_COUNT = 5;
// Distance (in px) the finger must travel before the row-level
// PanResponder claims the gesture from the per-star Pressables.
// Below the threshold: a tap, the Pressable handles it normally.
// Above: a drag, the PanResponder takes over and selection follows
// the finger across the row.
const DRAG_THRESHOLD_PX = 5;

// Map a row-relative X coordinate to a star value (1-5). Out-of-range
// values clamp to the nearest end — drag past the rightmost star pins
// to 5, drag left of the first star pins to 1. (Deselect-to-null lives
// on the tap-toggle path; drag never produces 0.)
function valueFromRowX(localX: number, rowWidth: number): number {
    if (rowWidth <= 0) return 1;
    const perStar = rowWidth / STAR_COUNT;
    const idx = Math.floor(localX / perStar);
    return Math.max(1, Math.min(STAR_COUNT, idx + 1));
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
    // Tentative selection — committed only when Done is pressed.
    // Tapping the same star a second time deselects it (back to null).
    const [selected, setSelected] = useState<number | null>(initialRating);
    // Press-in preview — lights stars while the user holds. Clears on
    // press-out so the display falls back to `selected`.
    const [pressedRating, setPressedRating] = useState<number | null>(null);
    // Measured row width — set via onLayout. Drives the X→star mapping
    // for drag gestures.
    const [rowWidth, setRowWidth] = useState(0);

    // Refs mirror state for the PanResponder closures: the responder is
    // created once via useRef, so its handlers can't close over the
    // latest state values. setSelected/setPressedRating are stable so
    // they don't need ref mirroring, but rowWidth and pressedRating
    // (which we *read* during handlers) do.
    const rowRef = useRef<View>(null);
    const rowWidthRef = useRef(0);
    const rowPageXRef = useRef(0);
    const pressedRatingRef = useRef<number | null>(null);
    // Which star last triggered a haptic. Drag haptics fire once per
    // transition into a new star rather than on every move event.
    const lastHapticStarRef = useRef<number | null>(null);

    useEffect(() => {
        rowWidthRef.current = rowWidth;
    }, [rowWidth]);
    useEffect(() => {
        pressedRatingRef.current = pressedRating;
    }, [pressedRating]);

    // Resync internal state to the prop each time the sheet opens, so
    // re-rate flows show the existing rating and first-rate flows
    // start unselected.
    useEffect(() => {
        if (visible) {
            setSelected(initialRating);
            setPressedRating(null);
            lastHapticStarRef.current = null;
        }
    }, [visible, initialRating]);

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

    // Row-level drag gesture. Quick taps still go through the per-star
    // Pressables (onStartShouldSet returns false); only crossing the
    // DRAG_THRESHOLD_PX claims the responder for drag-to-rate. Once
    // PanResponder owns the gesture, selection follows the finger and
    // commits on release with SET semantics (no toggle — dragging to
    // "3" means "I want 3", not "deselect if already 3").
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
                // Skip haptic if the per-star Pressable just fired one
                // for this same star — avoids the double-haptic when
                // the gesture transitions from Pressable to PanResponder.
                if (lastHapticStarRef.current !== value) {
                    lastHapticStarRef.current = value;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
            },
            onPanResponderMove: (_, g) => {
                const localX = g.moveX - rowPageXRef.current;
                const value = valueFromRowX(localX, rowWidthRef.current);
                setPressedRating(value);
                if (lastHapticStarRef.current !== value) {
                    lastHapticStarRef.current = value;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
            },
            onPanResponderRelease: () => {
                const committed = pressedRatingRef.current;
                setPressedRating(null);
                lastHapticStarRef.current = null;
                if (committed !== null) setSelected(committed);
            },
            onPanResponderTerminate: () => {
                setPressedRating(null);
                lastHapticStarRef.current = null;
            },
        }),
    ).current;

    function handleStarPressIn(value: number) {
        setPressedRating(value);
        // Share the haptic-tracker with the PanResponder so its
        // onPanResponderGrant doesn't re-fire a haptic for this star.
        lastHapticStarRef.current = value;
        // Letterboxd-style light impact as the finger lands. Fire and
        // forget — failures (unsupported device, etc.) are silent.
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    function handleStarPress(value: number) {
        // Tap-toggle: same star a second time clears the selection.
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
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={handleSkip}
        >
            <Pressable
                style={[styles.backdrop, { backgroundColor: palette.overlay }]}
                onPress={handleSkip}
            >
                <Pressable
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: palette.surface,
                            paddingBottom: insets.bottom + spacing.lg,
                        },
                    ]}
                    onPress={() => {}}
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
                        {[1, 2, 3, 4, 5].map((value) => {
                            const filled =
                                effectiveRating !== null && value <= effectiveRating;
                            const color = filled ? palette.accent : palette.textMuted;
                            return (
                                <Pressable
                                    key={value}
                                    onPressIn={() => handleStarPressIn(value)}
                                    onPressOut={() => setPressedRating(null)}
                                    onPress={() => handleStarPress(value)}
                                    disabled={busy}
                                    hitSlop={spacing.xs}
                                    style={({ pressed }) => [
                                        styles.starButton,
                                        { opacity: pressed || busy ? 0.6 : 1 },
                                    ]}
                                >
                                    <Star
                                        color={color}
                                        fill={filled ? palette.accent : 'transparent'}
                                        size={36}
                                    />
                                </Pressable>
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
                </Pressable>
            </Pressable>
        </Modal>
    );
}

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
    starButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
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
