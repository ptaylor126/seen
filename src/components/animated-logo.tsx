/**
 * AnimatedLogo — the "Seen" wordmark whose eye irises do a slow look-around
 * drift, for a loading state. STAGE 1: standalone, not wired into any loading
 * screen yet.
 *
 * Why hand-authored react-native-svg (not the .svg transformer): the exported
 * assets/wordwitheyes.svg is FLAT — no named <g> groups survived the export
 * (only the two gradient defs have ids). A transformer-imported .svg is also
 * an opaque component you can't reach into. To move the irises we need the
 * inner eye parts (iris + pupil + highlight) as addressable <G> elements, so
 * we re-create them here as two AnimatedG groups driven by Reanimated. The
 * sclerae and the wordmark stay static.
 *
 * Geometry is transcribed 1:1 from assets/wordwitheyes.svg (viewBox
 * 906 × 266). Left eye iris ~cx 318 within sclera cx 338.8; right eye iris
 * ~cx 544 within sclera cx 564.5 — both have ~49px-radius sclerae, so a small
 * ±X drift stays well inside.
 */
import { useCallback, useEffect } from 'react';
import Animated, {
    cancelAnimation,
    Easing,
    runOnJS,
    useAnimatedProps,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
import { palette } from '@/theme/theme';
import Svg, {
    Circle,
    Defs,
    Ellipse,
    G,
    LinearGradient,
    Path,
    Rect,
    Stop,
} from 'react-native-svg';

const AnimatedG = Animated.createAnimatedComponent(G);

// Full logo viewBox, and a tight crop around just the eyes for the eyes-only
// loader variant. EYES_VIEW = the two sclerae bbox (~289.6..613.6 x,
// ~92.8..160.9 y) + ~8px padding; the iris drift range (308..604) stays
// inside it, so nothing clips at the crop edges.
const FULL_VIEW = { x: 0, y: 0, w: 906, h: 266 };
// Eyes-only: each eye is pulled toward centre by EYE_SHIFT so the pair reads
// as one unit (the wordmark-era spacing leaves them too far apart alone).
// Applied ONLY when eyesOnly — the full logo keeps the eyes in the 'e's.
// The shift is symmetric, so the pair's centre stays at x≈452; EYES_VIEW is
// the tight crop around the SHIFTED pair (sclerae span ~345.6..557.6 + pad).
const EYE_SHIFT = 56;
const EYES_VIEW = { x: 338, y: 85, w: 228, h: 84 };

// Iris travel in SVG units. The resting iris sits ~20px LEFT of the eye
// centre, and the sclera only allows ~12px of further-left travel before the
// iris clips the rim — so a *symmetric* drift stays trapped on the left half
// (that's why it read one-sided). These ASYMMETRIC targets sweep the iris from
// a small look-left, across the eye centre, to a clear look-right — both sides
// plainly visible, nothing clips (left eye 318 → 308..362 within sclera
// 289.8..387.8; right eye mirrors it).
const LOOK_LEFT_X = -10;
const LOOK_RIGHT_X = 44;
// Loop pacing — noticeably quicker than the first pass (~1.7s/cycle vs ~6.3s),
// still eased so it reads smooth, not frantic.
const MOVE_MS = 650;
const PAUSE_MS = 220;

// Launch sequence (launch mode): hold on the full logo looking around for
// LOOK_HOLD_MS, then morph (wordmark fades + drops WORDMARK_DROP_Y while the
// eyes converge) over MORPH_MS; onIntroDone fires when the morph completes.
const WORDMARK_DROP_Y = 40;
const LOOK_HOLD_MS = 1500;
const MORPH_MS = 480;
// The iris rests ~21 units LEFT of the sclera centre (cx 318 vs 338.8), so the
// look-around's left dwell reads as "eyes looking left". The launch morph
// settles the gaze to this value so the eyes end CENTRED (looking straight),
// not paused at a look extreme — then the look-around resumes for the loader.
const CENTER_TX = 21;

interface AnimatedLogoProps {
    /** Rendered width in px; height follows the active viewBox aspect ratio. */
    width?: number;
    /** Eyes-only loader variant — just the two eyes (sclera + animated inner
     *  group), cropped tight, wordmark + 'e' fills dropped. Same motion. */
    eyesOnly?: boolean;
    /** Launch sequence: start as the full logo, look around briefly, then
     *  morph (wordmark fades/drops, eyes converge) into the eyes loader. */
    launch?: boolean;
    /** Fired when the launch morph finishes (eyes are now the loader). */
    onIntroDone?: () => void;
}

export function AnimatedLogo({
    width = 200,
    eyesOnly = false,
    launch = false,
    onIntroDone,
}: AnimatedLogoProps) {
    // Horizontal translate (SVG units) applied to both eyes' inner groups.
    const tx = useSharedValue(0);

    // The infinite look-around loop. Ping-pong: sweep right, pause, sweep left,
    // pause, repeat. withDelay holds the prior value (the pause) before each
    // move. Asymmetric targets (see consts) make the iris clearly visit BOTH
    // halves of the eye despite its left-offset resting position.
    const runLookAround = useCallback(() => {
        const EZ = Easing.inOut(Easing.quad);
        tx.value = withRepeat(
            withSequence(
                withDelay(
                    PAUSE_MS,
                    withTiming(LOOK_RIGHT_X, { duration: MOVE_MS, easing: EZ }),
                ),
                withDelay(
                    PAUSE_MS,
                    withTiming(LOOK_LEFT_X, { duration: MOVE_MS, easing: EZ }),
                ),
            ),
            -1, // infinite
            false,
        );
    }, [tx]);

    // Non-launch (full / eyesOnly loaders): look around continuously from mount.
    useEffect(() => {
        if (launch) return;
        runLookAround();
        return () => cancelAnimation(tx);
    }, [launch, runLookAround, tx]);

    // Both eyes look the same direction, so they share one animated transform.
    const eyeProps = useAnimatedProps(() => ({
        transform: [{ translateX: tx.value }],
    }));

    // Morph: 0 = full logo, 1 = converged eyes (wordmark gone). Static at the
    // mode's end value for full (0) / eyesOnly (1); animated 0→1 for launch.
    const morph = useSharedValue(eyesOnly ? 1 : 0);

    useEffect(() => {
        if (!launch) return;
        const EZ = Easing.inOut(Easing.quad);
        // Hold phase: look around on the full logo.
        runLookAround();
        // At the end of the hold, settle the gaze to centre over the morph's
        // duration so the eyes finish the morph CENTRED (not paused at a look
        // extreme). Assigning to tx replaces the look-around loop.
        const settle = setTimeout(() => {
            cancelAnimation(tx);
            tx.value = withTiming(CENTER_TX, { duration: MORPH_MS, easing: EZ });
        }, LOOK_HOLD_MS);
        // Morph the wordmark away + converge the eyes, in lockstep with the
        // settle. When it finishes: resume the look-around as the loader, and
        // notify the parent.
        morph.value = withDelay(
            LOOK_HOLD_MS,
            withTiming(1, { duration: MORPH_MS, easing: EZ }, (finished) => {
                if (finished) {
                    runOnJS(runLookAround)();
                    if (onIntroDone) runOnJS(onIntroDone)();
                }
            }),
        );
        return () => {
            clearTimeout(settle);
            cancelAnimation(tx);
            cancelAnimation(morph);
        };
    }, [launch, runLookAround, tx, morph, onIntroDone]);

    // Wordmark fades + drops as the morph runs.
    const wordmarkProps = useAnimatedProps(() => ({
        opacity: 1 - morph.value,
        transform: [{ translateY: morph.value * WORDMARK_DROP_Y }],
    }));
    // Outer eye groups converge toward centre as the morph runs (each whole eye
    // = sclera + its look-around inner group moves together).
    const rightEyeMorphProps = useAnimatedProps(() => ({
        transform: [{ translateX: -morph.value * EYE_SHIFT }],
    }));
    const leftEyeMorphProps = useAnimatedProps(() => ({
        transform: [{ translateX: morph.value * EYE_SHIFT }],
    }));

    const view = eyesOnly ? EYES_VIEW : FULL_VIEW;

    return (
        <Svg
            width={width}
            height={width * (view.h / view.w)}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            fill="none"
        >
            <Defs>
                <LinearGradient
                    id="iris_right"
                    x1="544.141"
                    y1="109.281"
                    x2="544.141"
                    y2="142.118"
                    gradientUnits="userSpaceOnUse"
                >
                    <Stop offset="0.192308" stopColor="#5F2C00" />
                    <Stop offset="1" stopColor="#DCB000" />
                </LinearGradient>
                <LinearGradient
                    id="iris_left"
                    x1="318.057"
                    y1="109.281"
                    x2="318.057"
                    y2="142.118"
                    gradientUnits="userSpaceOnUse"
                >
                    <Stop offset="0.192308" stopColor="#5F2C00" />
                    <Stop offset="1" stopColor="#DCB000" />
                </LinearGradient>
            </Defs>

            {!eyesOnly ? (
            <AnimatedG animatedProps={wordmarkProps}>
            {/* Wordmark + 'e' fills — fade/drop together during the morph. */}
            <Path
                d="M114.934 265.853C96.5737 265.853 79.9272 262.793 64.9944 256.673C50.3064 250.308 38.6784 241.006 30.1104 228.766C21.5424 216.526 16.8912 201.47 16.1568 183.6H74.9088C75.1536 190.699 76.9896 196.942 80.4168 202.327C83.844 207.713 88.4952 211.997 94.3704 215.179C100.246 218.117 107.1 219.586 114.934 219.586C121.543 219.586 127.296 218.607 132.192 216.648C137.333 214.445 141.372 211.385 144.31 207.468C147.247 203.307 148.716 198.166 148.716 192.046C148.716 185.681 147.002 180.295 143.575 175.889C140.148 171.238 135.497 167.321 129.622 164.138C123.746 160.711 116.892 157.651 109.058 154.958C101.47 152.021 93.2689 149.206 84.456 146.513C64.1376 139.903 48.4704 130.968 37.4544 119.707C26.6832 108.446 21.2976 93.3912 21.2976 74.5416C21.2976 58.8744 25.092 45.5328 32.6808 34.5168C40.5144 23.256 51.1632 14.688 64.6272 8.81279C78.0912 2.93759 93.3913 -1.04118e-05 110.527 -1.04118e-05C128.153 -1.04118e-05 143.698 3.05999 157.162 9.17999C170.626 15.0552 181.275 23.7456 189.108 35.2512C196.942 46.512 201.103 59.976 201.593 75.6432H142.474C142.229 70.2576 140.638 65.3616 137.7 60.9552C135.007 56.5488 131.213 52.9992 126.317 50.3064C121.666 47.6136 116.158 46.2672 109.793 46.2672C104.162 46.0224 99.0217 46.8792 94.3704 48.8376C89.964 50.5512 86.292 53.3664 83.3544 57.2832C80.6616 60.9552 79.3152 65.6064 79.3152 71.2368C79.3152 76.6224 80.6616 81.396 83.3544 85.5576C86.292 89.4744 90.2089 92.9016 95.1049 95.8392C100.246 98.532 106.121 101.102 112.73 103.55C119.585 105.998 127.051 108.446 135.13 110.894C148.104 115.301 159.977 120.564 170.748 126.684C181.764 132.559 190.577 140.393 197.187 150.185C204.041 159.732 207.468 172.462 207.468 188.374C207.468 202.327 203.796 215.179 196.452 226.93C189.353 238.68 178.949 248.105 165.24 255.204C151.776 262.303 135.007 265.853 114.934 265.853ZM339.413 265.853C320.319 265.853 303.55 261.936 289.107 254.103C274.664 246.024 263.281 234.886 254.957 220.687C246.879 206.244 242.84 189.72 242.84 171.115C242.84 152.021 246.879 135.007 254.957 120.074C263.036 105.142 274.297 93.3912 288.74 84.8232C303.183 76.2552 319.952 71.9712 339.046 71.9712C357.651 71.9712 373.93 76.0104 387.884 84.0888C401.838 92.1672 412.731 103.183 420.565 117.137C428.643 130.846 432.682 146.758 432.682 164.873C432.682 167.321 432.56 170.136 432.315 173.318C432.315 176.256 432.07 179.316 431.581 182.498H282.13V150.552H376.501C376.011 140.27 372.217 132.07 365.117 125.95C358.263 119.585 349.695 116.402 339.413 116.402C331.58 116.402 324.481 118.238 318.116 121.91C311.751 125.582 306.61 131.09 302.693 138.434C299.021 145.778 297.185 155.081 297.185 166.342V177.358C297.185 185.926 298.777 193.514 301.959 200.124C305.386 206.734 310.16 211.875 316.28 215.547C322.645 219.219 330.111 221.055 338.679 221.055C346.757 221.055 353.367 219.463 358.508 216.281C363.893 212.854 368.055 208.57 370.993 203.429H427.174C423.747 215.179 417.872 225.828 409.549 235.375C401.226 244.678 391.066 252.144 379.071 257.775C367.076 263.16 353.857 265.853 339.413 265.853ZM564.252 265.853C545.157 265.853 528.389 261.936 513.945 254.103C499.502 246.024 488.119 234.886 479.796 220.687C471.717 206.244 467.678 189.72 467.678 171.115C467.678 152.021 471.717 135.007 479.796 120.074C487.874 105.142 499.135 93.3912 513.578 84.8232C528.021 76.2552 544.79 71.9712 563.885 71.9712C582.489 71.9712 598.769 76.0104 612.722 84.0888C626.676 92.1672 637.57 103.183 645.403 117.137C653.482 130.846 657.521 146.758 657.521 164.873C657.521 167.321 657.398 170.136 657.154 173.318C657.154 176.256 656.909 179.316 656.419 182.498H506.969V150.552H601.339C600.849 140.27 597.055 132.07 589.956 125.95C583.101 119.585 574.533 116.402 564.252 116.402C556.418 116.402 549.319 118.238 542.954 121.91C536.589 125.582 531.449 131.09 527.532 138.434C523.86 145.778 522.024 155.081 522.024 166.342V177.358C522.024 185.926 523.615 193.514 526.797 200.124C530.225 206.734 534.998 211.875 541.118 215.547C547.483 219.219 554.949 221.055 563.517 221.055C571.596 221.055 578.205 219.463 583.346 216.281C588.732 212.854 592.893 208.57 595.831 203.429H652.013C648.586 215.179 642.71 225.828 634.387 235.375C626.064 244.678 615.905 252.144 603.91 257.775C591.914 263.16 578.695 265.853 564.252 265.853ZM698.025 261.447V76.3776H746.128L750.534 106.121C756.165 95.8392 764.121 87.6384 774.402 81.5184C784.684 75.1536 797.169 71.9712 811.857 71.9712C827.279 71.9712 840.254 75.276 850.78 81.8856C861.306 88.4952 869.262 98.0424 874.648 110.527C880.278 122.767 883.094 137.822 883.094 155.693V261.447H828.381V160.834C828.381 147.37 825.443 136.966 819.568 129.622C813.938 122.033 804.88 118.238 792.395 118.238C785.051 118.238 778.319 120.074 772.199 123.746C766.324 127.174 761.673 132.192 758.245 138.802C754.818 145.411 753.105 153.367 753.105 162.67V261.447H698.025Z"
                fill={palette.light.accent}
            />
            {/* The two 'e' fills under the eyes — static. */}
            <Path d="M522.159 110.51H603.746V160.822H522.159V110.51Z" fill={palette.light.accent} />
            <Rect
                x={297.794}
                y={110.51}
                width={81.5873}
                height={50.3122}
                fill={palette.light.accent}
            />
            </AnimatedG>
            ) : null}

            {/* Right eye — outer group converges during the morph. */}
            <AnimatedG animatedProps={rightEyeMorphProps}>
            <Ellipse
                cx="564.493"
                cy="126.848"
                rx="49.1335"
                ry="34.0155"
                fill="#D9D9D9"
            />
            <AnimatedG animatedProps={eyeProps}>
                <Circle
                    cx="544.141"
                    cy="125.699"
                    r="16.4185"
                    transform="rotate(-32.5928 544.141 125.699)"
                    fill="url(#iris_right)"
                />
                <Circle cx="544.141" cy="125.699" r="10.9457" fill={palette.light.accent} />
                <Path
                    d="M540.666 118.011C539.02 120.093 538.947 122.806 536.611 121.339C534.274 119.872 533.844 117.787 535.491 115.704C537.137 113.622 538.171 112.281 540.507 113.748C542.844 115.215 542.312 115.928 540.666 118.011Z"
                    fill="#FFFEFE"
                />
            </AnimatedG>
            </AnimatedG>

            {/* Left eye — outer group converges during the morph. */}
            <AnimatedG animatedProps={leftEyeMorphProps}>
            <Ellipse
                cx="338.768"
                cy="126.848"
                rx="49.1335"
                ry="34.0155"
                fill="#D9D9D9"
            />
            <AnimatedG animatedProps={eyeProps}>
                <Circle
                    cx="318.057"
                    cy="125.699"
                    r="16.4185"
                    transform="rotate(-32.5928 318.057 125.699)"
                    fill="url(#iris_left)"
                />
                <Circle cx="318.057" cy="125.699" r="10.9457" fill={palette.light.accent} />
                <Path
                    d="M314.582 118.011C312.936 120.093 312.863 122.806 310.526 121.339C308.19 119.872 307.76 117.787 309.406 115.704C311.053 113.622 312.087 112.281 314.423 113.748C316.76 115.215 316.228 115.928 314.582 118.011Z"
                    fill="#FFFEFE"
                />
            </AnimatedG>
            </AnimatedG>
        </Svg>
    );
}
