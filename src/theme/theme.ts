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
        bg: '#FAF7F2',
        surface: '#FFFFFF',
        surfaceAlt: '#F2EDE5',
        text: '#1A1614',
        textMuted: '#6B6661',
        textInverse: '#FFFFFF',
        border: '#E8E2DA',
        borderStrong: '#D4CCC1',
        accent: '#E5654A',
        accentPressed: '#C9523C',
        accentSubtle: '#FBE5DE',
        success: '#5B8E5A',
        warning: '#D89B3C',
        error: '#C04B3D',
        overlay: 'rgba(26, 22, 20, 0.5)',
    },
    dark: {
        bg: '#15110F',
        surface: '#1F1A17',
        surfaceAlt: '#2A2420',
        text: '#F5F1EB',
        textMuted: '#A39E97',
        textInverse: '#15110F',
        border: '#2E2823',
        borderStrong: '#3F3832',
        accent: '#F07A5F',
        accentPressed: '#E5654A',
        accentSubtle: '#3A2520',
        success: '#6FA86E',
        warning: '#E4AC4D',
        error: '#D75B4D',
        overlay: 'rgba(0, 0, 0, 0.6)',
    },
} as const;

export const typography = {
    // hero: reserved for marquee moments (onboarding welcome, splash).
    // Tight letter-spacing reads as confident headline copy rather
    // than generic large body text.
    hero: {
        fontSize: 44,
        fontWeight: '700' as const,
        lineHeight: 50,
        letterSpacing: -0.5,
    },
    display: { fontSize: 32, fontWeight: '700' as const, lineHeight: 38 },
    heading: { fontSize: 22, fontWeight: '600' as const, lineHeight: 28 },
    body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22 },
    bodyEmphasis: { fontSize: 16, fontWeight: '600' as const, lineHeight: 22 },
    caption: { fontSize: 14, fontWeight: '400' as const, lineHeight: 18 },
    micro: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
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
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
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

// Font family — values come into effect once @expo-google-fonts/dm-sans is
// loaded via expo-font in the root layout. Until then, components fall
// through to the system font.
export const fontFamily = {
    default: 'DMSans_400Regular',
    medium: 'DMSans_500Medium',
    semibold: 'DMSans_600SemiBold',
    bold: 'DMSans_700Bold',
} as const;

export type ColorScheme = 'light' | 'dark';

// Structural Palette type — widens the literal color strings of
// `palette.light` to plain `string` so both halves of the palette satisfy
// the contract. (The previous `typeof palette.light` alias failed because
// `as const` made every color a literal type, and the dark variants
// couldn't be assigned to the light-keyed literal type.)
export type Palette = {
    readonly [K in keyof typeof palette.light]: string;
};

export const getPalette = (scheme: ColorScheme): Palette => palette[scheme];
