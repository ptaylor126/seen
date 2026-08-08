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

import { StyleSheet } from 'react-native';

// ─── V2 redesign switch ────────────────────────────────────────────────
// The exploratory redesign: navy V2 palette + Bricolage Grotesque/Manrope
// type system. Flip to true LOCALLY to render V2; flip back before any
// commit — shipping the redesign is a deliberate, separate act. A Metro
// reload is required after flipping: typography and palette tokens are
// consumed inside module-scope StyleSheet.create calls, so the value is
// baked at bundle evaluation, not at render.
export const THEME_V2_ENABLED = true;

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
        // bg at zero alpha — the top stop for the rec header's image→page
        // fade. Identical colour to bg so the gradient is a pure ALPHA
        // ramp (no grey/pale midpoint); the bottom stop is bg exactly, so
        // the image melts straight into the page with no seam.
        bgTransparent: 'rgba(239, 231, 236, 0)',
        surface: '#FFFFFF',
        // Elevated card fill for cards sitting ON the plum page bg (the
        // title page's friends-watched + where-to-watch provider cards).
        // A CLEARLY plum-tinted light panel — distinctly more plum than
        // the page bg (#EFE7EC) so the card reads as an obvious soft plum
        // surface, not a near-white whisper. Earlier passes (#F8F0F5,
        // #EFDCEC) lightened it too far and it read as white; this is an
        // explicit, present soft plum — close to accentWash (#E4CADB) but a
        // touch lighter, still legible under provider logos + avatars.
        surfaceElevated: '#E4D3DF',
        surfaceAlt: '#E4DAE1',
        text: '#1A1614',
        textMuted: '#6B6661',
        // No V1 consumers yet — added so the Palette contract covers the
        // V2 redesign's third text tier. Placeholder value a step lighter
        // than textMuted; tune if a V1 surface ever adopts the tier.
        textFaint: '#8C8781',
        textInverse: '#FFFFFF',
        border: '#D9CBD4',
        borderStrong: '#D4CCC1',
        accent: '#7A3960',
        accentPressed: '#6A3252',
        accentSubtle: '#F0E4EC',
        // Shared "selected" fill for the Library filter zone — used by
        // ALL THREE selector controls (the segmented status picker, the
        // All/Movies/TV + Genre chips, and the grid/density view
        // controls) so every selected state across the zone reads
        // identically. A LIGHT plum wash: a deeper bump (#D8B5CC) was
        // tried and read too heavy/muddy, so this stays at the lighter
        // value. Contrast: 1.53:1 vs the segmented control's white
        // container, 1.12:1 vs the surfaceAlt zone the chips + grid sit
        // on; accent (#7A3960) text/icons on top read at 5.33:1. Sits
        // below the solid-plum tier (reserved for nav active pill +
        // action buttons). Distinct from accentSubtle, which is kept for
        // its other, lighter consumers (recommend / friends / rec
        // screens).
        accentWash: '#E4CADB',
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
        // families chosen to harmonize with the plum accent — all
        // cool/plum-leaning, no warm tones: plum and its harmonics
        // (violet, rose) + cool counterpoints (indigo, blue, cerulean,
        // teal, green). The previous bronze + warm-brown slots read as
        // orange against the plum UI and were replaced with indigo +
        // cerulean.
        avatarFallbacks: [
            { from: '#7A3960', to: '#5A2A48' }, // plum (matches accent)
            { from: '#3F587A', to: '#2D3F5C' }, // blue
            { from: '#474C93', to: '#353A73' }, // indigo
            { from: '#3F6B4F', to: '#2E5238' }, // green
            { from: '#5C497F', to: '#443560' }, // violet
            { from: '#8C4555', to: '#6B3242' }, // rose
            { from: '#2F6068', to: '#1F484F' }, // teal
            { from: '#2D6E96', to: '#1F5274' }, // cerulean
        ],
    },
    dark: {
        bg: '#16120F',
        // Parallel to light.bgTransparent — bg at 0 alpha for the rec
        // header image→page fade. (Dark mode not yet validated.)
        bgTransparent: 'rgba(22, 18, 15, 0)',
        surface: '#211B17',
        // Parallel to light.surfaceElevated — a clearly plum-leaning card
        // fill lifted above the dark bg. (Dark mode not yet validated.)
        surfaceElevated: '#33243A',
        surfaceAlt: '#2A2420',
        text: '#F5F1EB',
        textMuted: '#A39E97',
        // Parallel placeholder to light.textFaint (dark unvalidated).
        textFaint: '#736E67',
        textInverse: '#15110F',
        border: '#2E2823',
        borderStrong: '#3F3832',
        accent: '#9B5079',
        accentPressed: '#7A3960',
        accentSubtle: '#3A2233',
        // Parallel to light.accentWash — the shared filter-zone selected
        // fill, back at the lighter pre-bump value. Dark mode isn't
        // rendered/validated yet (app.json pinned to light); this exists
        // so the Palette type stays satisfied and is ready for the
        // dark-mode pass (final value to be tuned on device then).
        accentWash: '#4A2A3D',
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
            { from: '#5A5FA8', to: '#474C93' }, // indigo
            { from: '#4F7A60', to: '#3F6B4F' }, // green
            { from: '#7A669D', to: '#5C497F' }, // violet
            { from: '#A85F73', to: '#8C4555' }, // rose
            { from: '#3F757E', to: '#2F6068' }, // teal
            { from: '#387394', to: '#2D6E96' }, // cerulean
        ],
    },
} as const;

// OS status-bar style follows the theme: V1 keeps dark icons over the
// light palette; V2 is light icons everywhere over the navy. The root
// layout renders this as the app-wide default; screens that flip the
// bar over a banner (own profile, friend profile) restore to THIS, not
// a hardcoded style, so the restore stays theme-correct.
export const STATUS_BAR_STYLE: 'light-content' | 'dark-content' =
    THEME_V2_ENABLED ? 'light-content' : 'dark-content';

// ─── Type faces ────────────────────────────────────────────────────────
// V1: Geist everywhere. V2: Manrope for everything except the display
// tier (hero / display / headingDisplay), which takes Bricolage
// Grotesque — scoped to screen titles, profile header names, and future
// empty-state headlines, nothing else. Weight-for-weight mapping
// (400/500/600/700), size scale untouched — hierarchy tuning comes
// after the palette settles.
const BODY_FACES = THEME_V2_ENABLED
    ? {
          default: 'Manrope_400Regular',
          medium: 'Manrope_500Medium',
          semibold: 'Manrope_600SemiBold',
          bold: 'Manrope_700Bold',
      }
    : {
          default: 'Geist_400Regular',
          medium: 'Geist_500Medium',
          semibold: 'Geist_600SemiBold',
          bold: 'Geist_700Bold',
      };
const DISPLAY_FACE_BOLD = THEME_V2_ENABLED
    ? 'BricolageGrotesque_700Bold'
    : 'Geist_700Bold';
const DISPLAY_FACE_SEMIBOLD = THEME_V2_ENABLED
    ? 'BricolageGrotesque_600SemiBold'
    : 'Geist_600SemiBold';

// Each typography token references a specific loaded face by family
// name — the ONLY weight mechanism in the app. fontWeight is banned
// with custom families: Android resolves it by synthesizing (fake-bold
// on top of an already-bold face, or fallback for weights the family
// name can't satisfy) while iOS resolves differently, which is exactly
// the cross-platform type drift the 2026-08 parity pass removed. Weight
// changes go through fontFamily.<tier> / the display faces, never
// fontWeight.
export const typography = {
    // hero: reserved for marquee moments (onboarding welcome, splash).
    // Tight letter-spacing reads as confident headline copy rather
    // than generic large body text.
    hero: {
        fontFamily: DISPLAY_FACE_BOLD,
        fontSize: 44,
        lineHeight: 50,
        letterSpacing: -0.5,
    },
    display: {
        fontFamily: DISPLAY_FACE_BOLD,
        fontSize: 32,
        lineHeight: 38,
    },
    heading: {
        fontFamily: BODY_FACES.semibold,
        fontSize: 22,
        lineHeight: 28,
    },
    // heading metrics in the DISPLAY face. Exists for the V2 role
    // "profile header names get the display face at heading size" —
    // under V1 it's identical to `heading`, so adopting it early is
    // visually free. Do not reach for it outside the display-tier
    // roles (screen titles / header names / empty-state headlines).
    headingDisplay: {
        fontFamily: DISPLAY_FACE_SEMIBOLD,
        fontSize: 22,
        lineHeight: 28,
    },
    body: {
        fontFamily: BODY_FACES.default,
        fontSize: 16,
        lineHeight: 22,
    },
    // Connective tissue in activity sentences ("X watched Y", "A is now
    // your friend") — one step LIGHTER than body under V2 so the
    // emphasized names/titles pop without pushing emphasis heavier.
    // Long-form text (overviews, chat messages) stays on `body`. V1:
    // identical to body.
    bodyQuiet: {
        fontFamily: THEME_V2_ENABLED ? 'Manrope_300Light' : BODY_FACES.default,
        fontSize: 16,
        lineHeight: 22,
    },
    bodyEmphasis: {
        // V2: BOLD, not semibold. Manrope's 400↔600 distance is smaller
        // than Geist's, and the Geist-era emphasis was additionally
        // inflated on Android by the (since-removed) redundant
        // fontWeight's fake-bold — inline name/title emphasis inside
        // body text (inbox activity rows) read as one weight at 600.
        // V1 keeps Geist SemiBold, its original face.
        fontFamily: THEME_V2_ENABLED ? 'Manrope_700Bold' : BODY_FACES.semibold,
        fontSize: 16,
        lineHeight: 22,
    },
    caption: {
        fontFamily: BODY_FACES.default,
        fontSize: 14,
        lineHeight: 18,
    },
    micro: {
        fontFamily: BODY_FACES.medium,
        fontSize: 12,
        lineHeight: 16,
    },
    // Section-label tier — an uppercase, letter-spaced eyebrow that labels a
    // block (a poster strip, a review list) from ABOVE without competing with
    // the content it sits over. Deliberately a different register from the
    // 16/600 bodyEmphasis used for content titles: smaller, tracked, and
    // rendered in textMuted by its consumers, so heading vs content read as
    // two distinct tiers. Used by the friend profile's banded sections.
    overline: {
        fontFamily: BODY_FACES.semibold,
        fontSize: 12,
        lineHeight: 16,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
} as const;

export const spacing = {
    // Sub-scale optical nudge — the 2pt micro-gap used between tightly
    // stacked text lines, underlines, and badge insets. Added when token
    // consolidation found seventeen literal `2`s serving this one role.
    xxs: 2,
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

// Chip — the canonical filter / selection pill (Library media filters, genre
// chips + toggle, Friends sort chips). Geometry only; the active/inactive
// colours resolve from the palette at render (accentWash fill + accent text
// when selected; transparent fill + border + textMuted when not). See
// src/components/chip.tsx and the Chip section in DESIGN.md.
export const chip = {
    // md (12) rather than the original sm (8) — the labels sat tight against
    // the pill ends; one spacing step gives them air without ballooning the
    // chips.
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    // Hairline (≈0.33px @3x, 0.5px @2x — was a full 1px, which read heavy).
    // Light enough to recede, still enough outline for unselected chips to
    // read as tappable. Constant across states (selected = transparent at
    // the same width) so there's no layout shift on select.
    borderWidth: StyleSheet.hairlineWidth,
} as const;

// Button — the canonical full-width CTA (the filled plum Recommend / Save /
// Send primaries AND their outlined secondary siblings, which share rows and
// must match heights). Geometry only; fills/borders resolve from the palette
// at render. 14 vertical padding + the md radius reads a touch taller and
// clearly rounder than the old spacing.md/radius.sm pair (~50pt tall,
// radius:height ≈ 0.36) while staying well clear of the RN half-height pill
// clamp (25 at this height). Deliberately NOT applied to compact row-buttons,
// existing pills, ghost/text buttons, icon circles, the tab bar, segmented
// controls, or chips.
export const button = {
    // V2 exploration: one spacing step taller (base 16 vs the custom 14 —
    // ~54pt vs ~50pt) and fully-rounded pill ends. V1 unchanged.
    paddingVertical: THEME_V2_ENABLED ? spacing.base : 14,
    borderRadius: THEME_V2_ENABLED ? radius.full : radius.md,
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
export const fontFamily = BODY_FACES;

// Single-source stroke width for every lucide-react-native icon in
// the app. 1.5 reads as "thin and elegant" against the default 2;
// keeps icon weight consistent across nav, headers, and inline.
export const ICON_STROKE_WIDTH = 1.5;

// On-image ink — fixed colours for text, icons and chip fills rendered
// on top of photography (backdrops, posters, hero cards). Deliberately
// scheme-INDEPENDENT and outside the palette: the surface behind them
// is an image, not the theme background, so they must not flip with the
// colour scheme (palette.textInverse would — wrong tool here).
export const onImage = {
    text: '#FFFFFF',
    // Muted tier. Canonical value is the home hero's 0.82; the 0.78 and
    // 0.85 variants that had accreted around the same role were
    // consolidated onto it (sub-2% alpha shifts).
    textMuted: 'rgba(255,255,255,0.82)',
    textFaint: 'rgba(255,255,255,0.6)',
    // Dark pill/chip fill over images (home hero action chips, rec-screen
    // pills, title-page close button). V1: the plum-era warm black
    // (canonical 0.88; the rec pill's 0.85 consolidated here). V2: re-hued
    // to the ground family — the warm black read brown over warm artwork.
    chip: THEME_V2_ENABLED
        ? 'rgba(10, 12, 32, 0.9)'
        : 'rgba(36, 26, 32, 0.88)',
} as const;

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

// ─── V2 palette (exploratory redesign) ─────────────────────────────────
// Deep-navy system. Values marked "provisional" are expected to move
// during on-device tuning rounds — treat this block as the live tuning
// surface. onImage.* stays scheme-independent by design and is shared.
// Reserved, not yet a token: solid #D5CFEB for rare high-emphasis chips
// with dark text — introduce a named token with its first consumer.
export const paletteV2: Palette = {
    // The darkest navy — the canvas.
    bg: '#0B0D26',
    bgTransparent: 'rgba(11,13,38,0)',
    // Ground lifted ~6% lightness, same hue. PROVISIONAL — tune on device.
    surface: '#151838',
    // PROVISIONAL (unspecified in the brief): elevated cards, a step
    // above surface toward surfaceAlt, same hue family.
    surfaceElevated: '#1D2150',
    // The mid navy — EMPHASIS surfaces only (selected states, sticky
    // filter zone, tab bar). Not the default card colour.
    surfaceAlt: '#162954',
    text: '#E6E6E6',
    // PROVISIONAL — stepped down, warmed toward the navy. WCAG-checked:
    // 5.68:1 on surfaceAlt (clears the 4.5:1 bar for metadata on the
    // sticky zone), 6.89:1 on surface, 7.64:1 on ground.
    textMuted: '#9FA3B8',
    // PROVISIONAL.
    textFaint: '#6B6F85',
    // Dark navy on the light lavender accent (ground reused).
    textInverse: '#0B0D26',
    // TUNING: alpha temporarily 0.3 (spec value 0.08) to make every
    // border consumer visible while dialling by eye. Walk down
    // 0.3 → 0.15 → 0.12 → 0.10 with fast refresh, then settle.
    border: 'rgba(230,230,230,0.25)',
    // PROVISIONAL — border at double alpha.
    borderStrong: 'rgba(230,230,230,0.16)',
    accent: '#9D8DF0',
    // PROVISIONAL — accent stepped down for pressed states.
    accentPressed: '#8878DC',
    // accentMuted per the brief: #D5CFEB at 18% over surface, for wash
    // and selected fills. Both wash-role tokens share it.
    accentSubtle: 'rgba(213,207,235,0.18)',
    accentWash: 'rgba(213,207,235,0.18)',
    // PROVISIONAL — carried from the dark palette (built for dark bg).
    success: '#6FA86E',
    warning: '#E4AC4D',
    error: '#D75B4D',
    overlay: 'rgba(0,0,0,0.6)',
    shadow: '#000000',
    // Carried from the dark palette: contrast-verified for the white
    // initial on dark grounds. PROVISIONAL until an accent-family pass.
    avatarFallbacks: palette.dark.avatarFallbacks,
};

// V2: hairline frame on poster artwork so dark posters keep a defined
// edge against ground (dark art on dark canvas otherwise dissolves).
// Empty object under V1 — spreading it into a style is a no-op, so the
// 28 duplicated poster styles across the app all take `...posterFrame`
// unconditionally. Border colour is the V2 border token; the frame only
// exists under V2 so it never needs the V1 palette.
export const posterFrame = THEME_V2_ENABLED
    ? {
          // TUNING: bumped from StyleSheet.hairlineWidth so the frame is
          // clearly visible while dialling the border alpha by eye.
          borderWidth: 1,
          borderColor: paletteV2.border,
      }
    : {};

// V2 ignores the colour scheme: the redesign is a single dark-navy
// system (the app pins userInterfaceStyle to light anyway, so `scheme`
// is 'light' today in both branches).
export const getPalette = (scheme: ColorScheme): Palette =>
    THEME_V2_ENABLED ? paletteV2 : palette[scheme];
