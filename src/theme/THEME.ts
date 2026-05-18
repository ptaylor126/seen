// Design tokens for Seen.
// Always import from here. Never hardcode colors, spacing, or typography in components.
// Updates to the visual language happen here and propagate everywhere.

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
    // For React Native Reanimated / Animated, use these constants.
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

// Font family — assigned once fonts are loaded via expo-font.
export const fontFamily = {
  default: 'DMSans_400Regular',
  medium: 'DMSans_500Medium',
  semibold: 'DMSans_600SemiBold',
  bold: 'DMSans_700Bold',
} as const;

export type ColorScheme = 'light' | 'dark';
export type Palette = typeof palette.light;

export const getPalette = (scheme: ColorScheme): Palette => palette[scheme];