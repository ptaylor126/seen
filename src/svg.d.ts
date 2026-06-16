// Module declaration so `import HomeIcon from './home.svg'` is typed.
// The transformer (configured in metro.config.js) turns each .svg into
// a React component that accepts SvgProps from react-native-svg —
// width, height, color, stroke, strokeWidth, fill, opacity, etc.
//
// SvgProps' `color` prop is the relevant one for tinting: any path in
// the SVG whose stroke or fill is set to `currentColor` will inherit
// that prop value at render time. The nav-bar icons rely on this so
// the tab bar's tabBarActiveTintColor / tabBarInactiveTintColor
// (plum vs textMuted) recolour the icon without per-icon plumbing.

declare module '*.svg' {
    import type * as React from 'react';
    import type { SvgProps } from 'react-native-svg';
    const content: React.FC<SvgProps>;
    export default content;
}
