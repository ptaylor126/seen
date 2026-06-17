// Floating, rounded, inset tab bar passed to <Tabs tabBar={...}> in
// src/app/(tabs)/_layout.tsx. Replaces React Navigation's default
// bottom tab bar for the entire (tabs) group.
//
// Visual posture:
//   - Inset spacing.base from the left + right edges; lifted
//     FLOATING_NAV_BOTTOM_GAP above the bottom safe-area inset so it
//     sits clear of the home indicator on all devices.
//   - Rounded 30pt — heavily curved, near-pill (bar height is 56, so
//     half-height would be 28). Specific to this surface, not a
//     shared token. Goes with radius.xl (32) elsewhere visually.
//   - DARK background in both modes (intentional — pairs with the
//     hero card's dark overlay as cinematic bookends), with a faint
//     PLUM tint so the bar ties to palette.accent (Seen's plum)
//     rather than reading as generic warm-brown-black. Light mode:
//     #241A20. Dark mode: #2E2230 — a touch lighter than the dark
//     page bg #16120F so the bar reads as a distinct floating
//     surface rather than merging into it. Both literals
//     hardcoded here (not palette tokens) because no other surface
//     uses this plum-tinted dark; the rest of the warm-dark palette
//     (palette.dark.bg/surface/surfaceAlt) is warm-brown-dark.
//     Promote to tokens only if another surface adopts the same
//     tint. NO border, NO shadow — the dark-vs-bg tonal contrast
//     does the floating work on its own.
//   - Icon-only, no labels. Active: solid plum pill (palette.accent
//     per scheme) with an off-white icon on top. Inactive: icon
//     only on the dark bar (no pill), tinted a muted warm grey
//     pulled from the DARK palette (palettes.dark.textMuted) so it
//     reads on the dark surface regardless of the user's scheme —
//     the per-scheme palette.textMuted is tuned for LIGHT
//     backgrounds and would be invisible here.
//
// Scroll-container clearance: every scrollable tab screen needs
// bottom padding equal to useFloatingTabBarInset() so the last items
// in the list aren't hidden behind the floating bar. See call sites
// in (tabs)/index.tsx, library.tsx, friends.tsx, profile.tsx.
//
// Route-name → icon mapping stays in the Tabs.Screen options
// (options.tabBarIcon per route), not hardcoded here — keeps this
// component generic and lets the route file own its icon binding.

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import {
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPalette, palette as palettes, radius, spacing } from '@/theme/theme';

// Bar's intrinsic height — sized for clear breathing room around the
// 44pt active pill. Math: 44pt pill + 12pt top + 12pt bottom = 68pt.
// Consumers of useFloatingTabBarInset() pick up changes here at
// render time, so bumping this value automatically updates every
// scroll-container's bottom padding — no per-screen edit needed.
export const FLOATING_NAV_HEIGHT = 68;
// Vertical gap between the safe-area inset and the bar — small breath
// so the bar isn't visually glued to the home indicator on devices
// that have one, and not glued to the screen edge on devices that
// don't.
export const FLOATING_NAV_BOTTOM_GAP = 8;

// Computed bottom padding any scrollable tab screen needs in its
// contentContainerStyle so its last items don't hide behind the
// floating bar. Exposed as a hook so each consumer captures the
// runtime safe-area inset of the current device.
export function useFloatingTabBarInset(): number {
    const insets = useSafeAreaInsets();
    return FLOATING_NAV_HEIGHT + FLOATING_NAV_BOTTOM_GAP + insets.bottom;
}

// Per-tab pill geometry (centered inside the full-width tap area).
// 44pt holds the 28pt icon with 8pt padding per side — same
// proportional padding as the previous 24/40 pairing.
const PILL_SIZE = 44;
// Icon size — 28pt reads as confident at this bar height; the
// previous 24pt felt undersized once the bar gained the dark
// surface (icons need more weight on dark to match their visual
// presence on light surfaces).
const ICON_SIZE = 28;

// Bar surface colours — see file header for rationale. Plum-tinted
// darks (faint red/violet in the warm dark) so the bar reads as
// "Seen's dark" rather than generic black; ties to palette.accent.
const BAR_BG_LIGHT = '#241A20';
const BAR_BG_DARK = '#2E2230';

export function FloatingTabBar({
    state,
    descriptors,
    navigation,
}: BottomTabBarProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    // Bar surface — see file header for rationale. Plum-tinted dark
    // in both modes; dark mode value is lifted vs the page bg so
    // the bar still reads as a distinct floating surface.
    const barBg = scheme === 'light' ? BAR_BG_LIGHT : BAR_BG_DARK;
    // Icon tints on the dark bar — drawn from the DARK palette in
    // both modes (the bar is always dark). The per-scheme
    // palette.textMuted is tuned for light bg and would be invisible
    // here in light mode.
    const inactiveIconColor = palettes.dark.textMuted;
    const activeIconColor = palettes.dark.text;

    return (
        <View
            style={[
                styles.bar,
                {
                    backgroundColor: barBg,
                    bottom: insets.bottom + FLOATING_NAV_BOTTOM_GAP,
                },
            ]}
            // Default pointerEvents — every pixel of the bar is its
            // own surface (the page bg shows through above the bar
            // either way, since the bar is inset from the sides
            // it doesn't span the full width).
        >
            {state.routes.map((route, index) => {
                const { options } = descriptors[route.key];
                const isFocused = state.index === index;
                const tintColor = isFocused
                    ? activeIconColor
                    : inactiveIconColor;

                const onPress = () => {
                    // Standard React Navigation tabPress dance — emit
                    // the event so screens that subscribe (e.g.
                    // scroll-to-top on re-tap) get notified; only
                    // navigate if no listener prevented default AND
                    // we're not already on this tab.
                    const event = navigation.emit({
                        type: 'tabPress',
                        target: route.key,
                        canPreventDefault: true,
                    });
                    if (!isFocused && !event.defaultPrevented) {
                        navigation.navigate(route.name, route.params);
                    }
                };

                const onLongPress = () => {
                    navigation.emit({
                        type: 'tabLongPress',
                        target: route.key,
                    });
                };

                const accessibilityLabel =
                    options.tabBarAccessibilityLabel ??
                    options.title ??
                    route.name;

                return (
                    <Pressable
                        key={route.key}
                        onPress={onPress}
                        onLongPress={onLongPress}
                        accessibilityRole="button"
                        accessibilityState={
                            isFocused ? { selected: true } : {}
                        }
                        accessibilityLabel={accessibilityLabel}
                        style={({ pressed }) => [
                            styles.tab,
                            pressed && { opacity: 0.6 },
                        ]}
                    >
                        <View
                            style={[
                                styles.pill,
                                isFocused && {
                                    backgroundColor: palette.accent,
                                },
                            ]}
                        >
                            {options.tabBarIcon?.({
                                focused: isFocused,
                                color: tintColor,
                                size: ICON_SIZE,
                            })}
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    bar: {
        // Floating: absolutely-positioned, inset from sides, bottom
        // set inline (insets.bottom + FLOATING_NAV_BOTTOM_GAP).
        position: 'absolute',
        left: spacing.base,
        right: spacing.base,
        height: FLOATING_NAV_HEIGHT,
        // 30pt — heavily curved, near-pill (half-height would be 28).
        // Sits visually between radius.lg (24) and radius.xl (32);
        // specific to this surface, not promoted to a token until
        // another surface adopts the same value.
        borderRadius: 30,
        flexDirection: 'row',
        alignItems: 'center',
        // Inner horizontal padding so the first/last tab's tap area
        // doesn't touch the bar's rounded edges.
        paddingHorizontal: spacing.sm,
    },
    tab: {
        // Full-width tap target per tab (4 tabs share the bar's
        // inner width equally via flex: 1). The visual pill is a
        // smaller fixed-size centered element inside this larger
        // tap area — bigger touch target than the pill itself.
        flex: 1,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    pill: {
        // Active-state visual: fills with SOLID palette.accent (plum)
        // when focused; otherwise transparent (the bar's dark surface
        // shows through and the icon sits on the bar directly).
        // 44×44 with radius.full = circle.
        width: PILL_SIZE,
        height: PILL_SIZE,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
