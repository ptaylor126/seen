import type { Ref } from 'react';
import {
    Platform,
    Text as RNText,
    StyleSheet,
    useWindowDimensions,
    type TextProps,
} from 'react-native';

// App-wide font-scale clamp. OS font scaling is respected (accessibility)
// but capped so layouts built at 1.0x survive enlarged text instead of
// wrapping mid-word or clipping — Android allows up to 2.0x unclamped.
// Deliberately a clamp, never allowFontScaling={false}: text still grows
// with the user's setting, up to this multiplier. Shared with the TextInput
// wrapper (text-input.tsx) so inputs and labels scale in lockstep.
export const MAX_FONT_SCALE = 1.3;

// Drop-in replacement for react-native's Text — identical props, but
// maxFontSizeMultiplier defaults to the clamp. Import Text from here, not
// from 'react-native'. Spread AFTER the default so a reading surface that
// should scale further (long-form body text) can pass its own
// maxFontSizeMultiplier and win.
//
// ANDROID lineHeight repair: the typography tokens carry fixed dp
// lineHeights sized for 1.0x glyphs. iOS multiplies an explicit lineHeight
// by the font scale itself, so scaled text keeps breathing room there — but
// Android leaves it fixed, so 1.3x glyphs render inside a 1.0x line box and
// clip their ascenders/descenders (the "Recommend to a friend" clip). When
// the OS scale exceeds 1, scale any explicit lineHeight by the same
// effective multiplier the glyphs get (the OS scale, capped by this Text's
// maxFontSizeMultiplier). Gated to Platform.OS === 'android' so iOS is
// never double-scaled, and inert at fontScale <= 1 (and when a caller opts
// out via allowFontScaling={false}, where the glyphs stay unscaled too).
export function Text(props: TextProps & { ref?: Ref<RNText> }) {
    const { fontScale } = useWindowDimensions();

    let style = props.style;
    if (
        Platform.OS === 'android' &&
        fontScale > 1 &&
        props.allowFontScaling !== false
    ) {
        const lineHeight = StyleSheet.flatten(style)?.lineHeight;
        if (lineHeight != null) {
            // Match the glyphs' effective multiplier: OS scale capped by
            // this Text's max (0 means "no max" in RN, so scale freely).
            const cap = props.maxFontSizeMultiplier ?? MAX_FONT_SCALE;
            const factor = cap > 0 ? Math.min(fontScale, cap) : fontScale;
            style = [style, { lineHeight: lineHeight * factor }];
        }
    }

    return (
        <RNText
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            {...props}
            style={style}
        />
    );
}
