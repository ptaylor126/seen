import { Dimensions, StyleSheet, useColorScheme, View } from 'react-native';

import { getPalette } from '@/theme/theme';

const SCREEN_W = Dimensions.get('window').width;

// Arch geometry, measured off the profile mockup: the sheet's top edge is a
// continuous circular arc whose radius equals the screen width. That gives a
// crest depth (sagitta) of W·(1 − √3/2) ≈ 0.134·W — ~53pt on a 393pt screen —
// with the arc meeting the screen edges exactly at the cap's bottom line, so
// the cap joins the flat sheet below seamlessly. Pure Views (a clipped
// oversize circle), no SVG.
export const ARCH_DEPTH = Math.round(SCREEN_W * (1 - Math.sqrt(3) / 2));

// The arched top of the white sheet, drawn over a plum field: a full-width
// strip ARCH_DEPTH tall whose child is a 2W-diameter circle in the sheet
// color — the strip clips it to the visible arc. Rendered between the plum
// banner zone and the sheet body; both profile screens share it so the curve
// cannot drift between them.
export function ArchCap() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    return (
        <View style={[styles.cap, { backgroundColor: palette.accent }]}>
            <View style={[styles.crest, { backgroundColor: palette.bg }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    cap: {
        width: '100%',
        height: ARCH_DEPTH,
        overflow: 'hidden',
    },
    crest: {
        alignSelf: 'center',
        width: SCREEN_W * 2,
        height: SCREEN_W * 2,
        borderRadius: SCREEN_W,
    },
});
