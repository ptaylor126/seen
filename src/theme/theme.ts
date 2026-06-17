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
        // Light surface ramp carries a subtle plum undertone (R>B>G,
        // ~3% saturation — a warm plum cast, not an obviously coloured
        // bg) so white surfaces (search bar, cards, white pills)
        // visibly separate from the page. Before this, bg #F7F5F1 vs
        // surface #FFFFFF was only 1.089:1 — effectively the same
        // tone — so white surfaces had no separation. The whole ramp
        // was shifted down one notch (not just bg) to KEEP the gaps
        // intact: deepening bg alone into the ~81 lum range would have
        // collided with surfaceAlt (81.0) and flattened the recessed
        // filter zone. Adjacent contrasts now: surface→bg 1.213,
        // bg→surfaceAlt 1.123 (≈ the old 1.122), surfaceAlt→border
        // 1.147. Dark mode deliberately NOT given a parallel tint yet
        // — dark isn't rendered/validated (app.json pinned to light);
        // the parallel plum-tint belongs in the dark-mode pass.
        bg: '#EFE7EC',
        surface: '#FFFFFF',
        surfaceAlt: '#E4DAE1',
        text: '#1A1614',
        textMuted: '#6B6661',
        textInverse: '#FFFFFF',
        border: '#D9CBD4',
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
        // Avatar fallback gradients used when no avatar image is
        // available. Hashed deterministically from a stable user id
        // (djb2 in src/components/avatar.tsx) so the same user always
        // gets the same pair — kept at exactly 8 pairs so the modulo
        // matches the previous flat-colour set and existing avatars
        // map to "their" colour, just rendered as a gentle two-tone
        // gradient now. Each pair is a small from→to shift within one
        // hue family (Notion/Linear style — visible but muted). The
        // initial sits as WHITE text on top in both themes, so the
        // LIGHTER stop (the "from" / top-left of the diagonal) is
        // contrast-verified at ≥4.5:1 against white via WCAG. Hue
        // families chosen to harmonize with the plum accent — plum
        // and its harmonics (violet, rose) + warm earthy tones
        // (bronze, brown) + cool counterpoints (blue, teal, green).
        avatarFallbacks: [
            { from: '#7A3960', to: '#5A2A48' }, // plum (matches accent)
            { from: '#3F587A', to: '#2D3F5C' }, // blue
            { from: '#8B6135', to: '#6E4925' }, // bronze
            { from: '#3F6B4F', to: '#2E5238' }, // green
            { from: '#5C497F', to: '#443560' }, // violet
            { from: '#8C4555', to: '#6B3242' }, // rose
            { from: '#2F6068', to: '#1F484F' }, // teal
            { from: '#6F4A37', to: '#543526' }, // warm brown
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
        // Parallel set to light.avatarFallbacks — same 8 hue families
        // in the same slot order so the same `seedId` maps to the
        // same family across themes (a user's "rose" avatar stays
        // "their" rose in dark mode). Each pair is slightly lifted
        // vs the light variant so the gradient pops against the dark
        // bg (#16120F), but still mid-dark enough to hold the WHITE
        // initial at ≥4.5:1 contrast — every "from" stop verified.
        avatarFallbacks: [
            { from: '#9B5079', to: '#7A3960' }, // plum (matches accent)
            { from: '#587398', to: '#3F587A' }, // blue
            { from: '#8C6440', to: '#6E4925' }, // bronze
            { from: '#4F7A60', to: '#3F6B4F' }, // green
            { from: '#7A669D', to: '#5C497F' }, // violet
            { from: '#A85F73', to: '#8C4555' }, // rose
            { from: '#3F757E', to: '#2F6068' }, // teal
            { from: '#8C6450', to: '#6F4A37' }, // warm brown
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
// tokens widen to a plain-string-element shape so the matching pair of
// arrays from `palette.dark` is structurally assignable. Today there's
// one array-of-objects token (avatarFallbacks: { from, to }[]) and
// no string-array tokens, but the readonly-string[] branch stays for
// future tokens of that shape.
type WidenPaletteValue<V> =
    V extends readonly { from: string; to: string }[]
        ? readonly { from: string; to: string }[]
        : V extends readonly string[]
            ? readonly string[]
            : string;
export type Palette = {
    readonly [K in keyof typeof palette.light]: WidenPaletteValue<
        (typeof palette.light)[K]
    >;
};

export const getPalette = (scheme: ColorScheme): Palette => palette[scheme];
