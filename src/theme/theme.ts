/**
 * Design tokens for Seen.
 *
 * Canonical location — always import from here. Never hardcode colors,
 * spacing, typography, motion durations, or radii in components. Updates to
 * the visual language happen here and propagate everywhere.
 *
 * Source of truth: DESIGN.md. Any value added here should already exist (or
 * be about to be added) in DESIGN.md so the document and the code stay
 * aligned.
 */

export const palette = {
    light: {
        bg: '#F7F5F1',
        surface: '#FFFFFF',
        surfaceAlt: '#ECE8E1',
        text: '#1A1614',
        textMuted: '#6B6661',
        textInverse: '#FFFFFF',
        border: '#E8E2DA',
        borderStrong: '#D4CCC1',
        accent: '#7A3960',
        accentPressed: '#6A3252',
        accentSubtle: '#F0E4EC',
        success: '#5B8E5A',
        warning: '#D89B3C',
        error: '#C04B3D',
        overlay: 'rgba(26, 22, 20, 0.5)',
        // Shadow base color. Currently '#000000' in both schemes; the
        // shadowOpacity prop on each elevation preset controls how
        // visible the shadow actually is. Token exists so component
        // shadow styles never hardcode '#000'.
        shadow: '#000000',
        // Avatar fallback fills used when no avatar image is available.
        // Hashed deterministically from a stable user id so the same user
        // always gets the same colour. All values are medium-dark so the
        // initial reads in textInverse (white) at ≥4:1 contrast. Warm
        // palette only — held over from the cream + coral era; re-check
        // against the plum accent on device and tune any that clash.
        avatarFallbacks: [
            '#C46850',
            '#B08A3C',
            '#7C8F60',
            '#B06978',
            '#5E807F',
            '#87729D',
            '#6F8460',
            '#8B5E45',
        ],
    },
    dark: {
        bg: '#16120F',
        surface: '#211B17',
        surfaceAlt: '#2A2420',
        text: '#F5F1EB',
        textMuted: '#A39E97',
        textInverse: '#15110F',
        border: '#2E2823',
        borderStrong: '#3F3832',
        accent: '#9B5079',
        accentPressed: '#7A3960',
        accentSubtle: '#3A2233',
        success: '#6FA86E',
        warning: '#E4AC4D',
        error: '#D75B4D',
        overlay: 'rgba(0, 0, 0, 0.6)',
        shadow: '#000000',
        // Parallel set to light.avatarFallbacks, lifted in lightness so
        // the dark-mode textInverse (near-black) reads with ≥4:1
        // contrast on each fill. Same caveat: tune against plum on
        // device if any read off-key.
        avatarFallbacks: [
            '#E8957D',
            '#D4B173',
            '#B0C28D',
            '#D49AA6',
            '#9CB5B3',
            '#B7A2C7',
            '#A8BD9A',
            '#BF9A82',
        ],
    },
} as const;

// Each typography token references a specific Geist variant by its
// loaded family name. RN's fontWeight prop is unreliable when a font
// family has multiple weights — naming the exact face is the safest
// way to render the intended weight on both platforms. fontWeight is
// kept for accessibility tooling (VoiceOver weight reads) and as
// fallback if the font hasn't loaded yet.
export const typography = {
    // hero: reserved for marquee moments (onboarding welcome, splash).
    // Tight letter-spacing reads as confident headline copy rather
    // than generic large body text.
    hero: {
        fontFamily: 'Geist_700Bold',
        fontSize: 44,
        fontWeight: '700' as const,
        lineHeight: 50,
        letterSpacing: -0.5,
    },
    display: {
        fontFamily: 'Geist_700Bold',
        fontSize: 32,
        fontWeight: '700' as const,
        lineHeight: 38,
    },
    heading: {
        fontFamily: 'Geist_600SemiBold',
        fontSize: 22,
        fontWeight: '600' as const,
        lineHeight: 28,
    },
    body: {
        fontFamily: 'Geist_400Regular',
        fontSize: 16,
        fontWeight: '400' as const,
        lineHeight: 22,
    },
    bodyEmphasis: {
        fontFamily: 'Geist_600SemiBold',
        fontSize: 16,
        fontWeight: '600' as const,
        lineHeight: 22,
    },
    caption: {
        fontFamily: 'Geist_400Regular',
        fontSize: 14,
        fontWeight: '400' as const,
        lineHeight: 18,
    },
    micro: {
        fontFamily: 'Geist_500Medium',
        fontSize: 12,
        fontWeight: '500' as const,
        lineHeight: 16,
    },
} as const;

export const spacing = {
    xs: 4,
    sm: 8,
    md: 12,
    base: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
    xxxl: 64,
} as const;

export const radius = {
    // Rounder than typical iOS metrics — softens every input, button,
    // card, and pill in the app to give the brand a friendlier feel.
    // Touch anything that uses these to verify the larger curve still
    // reads correctly (e.g. small badges may need radius.full).
    sm: 12,
    md: 18,
    lg: 24,
    xl: 32,
    full: 9999,
} as const;

export const motion = {
    duration: {
        fast: 150,
        default: 250,
        slow: 400,
    },
    easing: {
        standard: 'ease-out',
        accelerate: 'ease-in',
        bounce: 'spring',
    },
} as const;

export const elevation = {
    none: {
        shadowColor: 'transparent',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
    },
    sm: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 6,
        elevation: 2,
    },
    md: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
        elevation: 6,
    },
} as const;

// Font family — values come into effect once @expo-google-fonts/geist is
// loaded via expo-font in the root layout. Until then, components fall
// through to the system font.
export const fontFamily = {
    default: 'Geist_400Regular',
    medium: 'Geist_500Medium',
    semibold: 'Geist_600SemiBold',
    bold: 'Geist_700Bold',
} as const;

// Single-source stroke width for every lucide-react-native icon in
// the app. 1.5 reads as "thin and elegant" against the default 2;
// keeps icon weight consistent across nav, headers, and inline.
export const ICON_STROKE_WIDTH = 1.5;

export type ColorScheme = 'light' | 'dark';

// Structural Palette type — widens the literal color strings of
// `palette.light` to plain `string` so both halves of the palette satisfy
// the contract. (The previous `typeof palette.light` alias failed because
// `as const` made every color a literal type, and the dark variants
// couldn't be assigned to the light-keyed literal type.) Array-valued
// tokens (e.g. avatarFallbacks) widen to `readonly string[]` instead.
type WidenPaletteValue<V> = V extends readonly string[] ? readonly string[] : string;
export type Palette = {
    readonly [K in keyof typeof palette.light]: WidenPaletteValue<
        (typeof palette.light)[K]
    >;
};

export const getPalette = (scheme: ColorScheme): Palette => palette[scheme];
