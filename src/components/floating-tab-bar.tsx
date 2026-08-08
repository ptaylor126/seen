// Floating, rounded, inset tab bar passed to <Tabs tabBar={...}> in
// src/app/(tabs)/_layout.tsx. Replaces React Navigation's default
// bottom tab bar for the entire (tabs) group.
//
// Visual posture:
//   - Inset spacing.base from the left + right edges; lifted
//     FLOATING_NAV_BOTTOM_GAP above the bottom safe-area inset so it
//     sits clear of the home indicator on all devices.
//   - Rounded 30pt — heavily curved, near-pill (bar height is 68, so
//     half-height would be 34). Specific to this surface, not a
//     shared token. Goes with radius.xl (32) elsewhere visually.
//   - LIGHTER, on-brand tinted fill (was a dark plum that read as
//     overbearing). A near-opaque plum-grey close to the app bg so the
//     bar settles into the page. Built as a modest expo-blur layer with
//     a HIGH-opacity tint (~0.9) on top: the tint carries legibility
//     over busy content (posters), the blur just adds a whisper of
//     depth at the edges. NOT see-through — low-opacity glass fails
//     over bright posters. Light: #E4DAE1 @ .9. Dark: #2A2030 @ .9.
//     NO border, NO shadow — the tonal step from the bg does the
//     floating work.
//   - Icon-only, no labels. Active: a single SOLID coral STADIUM pill
//     (palette.accent, wider than tall, fully rounded ends — WhatsApp
//     proportions) that SLIDES between tabs, with a white icon on top
//     (coral reads strongly on the light bar; white reads on the coral
//     pill in both schemes — palette.textInverse is dark in dark mode,
//     so it can't be reused here). Inactive: icon only, palette.textMuted
//     (per-scheme, tuned for the now-light bar).
//
// Motion: the pill is one shared element animated via a reanimated
// shared value off state.index — translateX to the focused tab's
// measured center, subtle + quick (no spring/bounce) since it's a
// frequent everyday transition. Each tab's center is measured with
// onLayout. The icon tint is NOT a naive boolean cross-fade (that
// flashed: two half-opacity copies went translucent at the midpoint,
// and the colour flipped before the pill arrived). Instead each tab
// keeps a SOLID muted base icon with a white copy on top whose opacity
// is derived from the pill's live position — so the icon is white only
// where the pill actually covers it, and is never translucent. Colour
// and position move together, no flash.
//
// Scroll-container clearance: every scrollable tab screen needs
// bottom padding equal to useFloatingTabBarInset() so the last items
// in the list aren't hidden behind the floating bar. See call sites
// in (tabs)/index.tsx, library.tsx, friends.tsx, profile.tsx.
//
// Route-name → icon mapping stays in the Tabs.Screen options
// (options.tabBarIcon per route), not hardcoded here — keeps this
// component generic and lets the route file own its icon binding.

import type {
    BottomTabBarProps,
    BottomTabNavigationOptions,
} from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import {
    type GestureResponderEvent,
    type LayoutChangeEvent,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';
import Animated, {
    Easing,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPalette, onImage, radius, spacing } from '@/theme/theme';

// Bar's intrinsic height — sized for clear breathing room around the
// active pill. Consumers of useFloatingTabBarInset() pick up changes
// here at render time, so bumping this value automatically updates
// every scroll-container's bottom padding — no per-screen edit needed.
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

// Active pill — a STADIUM (wider than tall, fully rounded ends), WhatsApp
// proportions. 60×38 holds the 28pt icon with generous horizontal padding;
// borderRadius.full renders the rounded ends.
const PILL_WIDTH = 60;
const PILL_HEIGHT = 38;
// Icon size — 28pt reads as confident at this bar height.
const ICON_SIZE = 28;

// Bar tint — a high-opacity (~0.82) plum-grey over the blur. Still near-opaque
// so busy content (posters) behind stays legible, but a touch more see-through
// than before, with the blur picking up the slack. Light: #E4DAE1 @ .82.
// Dark: #2A2030 @ .82 (a plum-tinted elevated dark). NOTE: this is the
// legibility-critical value — judge it over a BRIGHT, busy poster, not a calm
// screen; drop it lower only if a bright backdrop stays readable.
const BAR_TINT_LIGHT = 'rgba(228, 218, 225, 0.82)';
const BAR_TINT_DARK = 'rgba(42, 32, 48, 0.82)';
// Blur — bumped a little now that the tint is slightly more transparent, so the
// material reads as frosted rather than plain. The tint still carries most of
// the legibility work.
const BLUR_INTENSITY = 40;
// Icon on the coral active pill — white in both schemes. (palette.textInverse
// is dark in dark mode, so it can't be reused here.) Reads on accent in both.
const ON_PILL_ICON_COLOR = onImage.text;
// Active-state motion — subtle + quick, no spring/bounce (frequent everyday
// transition).
const SLIDE_MS = 220;

// One tab cell. Extracted so it can own the per-icon useAnimatedStyle hook
// (can't call hooks inside the routes .map). Renders a solid muted base icon
// with a white copy on top whose opacity tracks the pill's live coverage of
// this tab — see file header (this is the no-flash icon tint).
function TabItem({
    index,
    isFocused,
    translateX,
    tabCenter,
    tabWidth,
    inactiveIconColor,
    icon,
    accessibilityLabel,
    onPress,
    onLongPress,
    onLayout,
}: {
    index: number;
    isFocused: boolean;
    translateX: SharedValue<number>;
    tabCenter: number | undefined;
    tabWidth: number;
    inactiveIconColor: string;
    icon: BottomTabNavigationOptions['tabBarIcon'];
    accessibilityLabel: string;
    onPress: () => void;
    onLongPress: () => void;
    onLayout: (e: LayoutChangeEvent) => void;
}) {
    // White (on-pill) icon opacity, derived from how centered the pill is over
    // this tab: 1 when the pill is exactly over this tab's center, ramping to 0
    // by the time it reaches an adjacent tab. Falls back to the focused boolean
    // until the bar has measured (tabWidth/tabCenter known).
    const activeIconStyle = useAnimatedStyle(() => {
        if (tabWidth <= 0 || tabCenter == null) {
            return { opacity: isFocused ? 1 : 0 };
        }
        const pillCenter = translateX.value + PILL_WIDTH / 2;
        const dist = Math.abs(pillCenter - tabCenter);
        const o = 1 - dist / tabWidth;
        return { opacity: o < 0 ? 0 : o > 1 ? 1 : o };
    });

    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            onLayout={onLayout}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [styles.tab, pressed && { opacity: 0.6 }]}
        >
            <View style={styles.iconWrap}>
                {/* Solid muted base — always opaque, so the composite is never
                    translucent regardless of the white layer's opacity. */}
                <View style={styles.iconLayer}>
                    {icon?.({
                        focused: isFocused,
                        color: inactiveIconColor,
                        size: ICON_SIZE,
                    })}
                </View>
                {/* White copy on top — opacity tracks the pill's coverage. */}
                <Animated.View style={[styles.iconLayer, activeIconStyle]}>
                    {icon?.({
                        focused: isFocused,
                        color: ON_PILL_ICON_COLOR,
                        size: ICON_SIZE,
                    })}
                </Animated.View>
            </View>
        </Pressable>
    );
}

export function FloatingTabBar({
    state,
    descriptors,
    navigation,
}: BottomTabBarProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();

    const barTint = scheme === 'light' ? BAR_TINT_LIGHT : BAR_TINT_DARK;
    const inactiveIconColor = palette.textMuted;

    // Measured center x of each tab (relative to the bar). Drives where the
    // sliding pill parks. Measured via per-tab onLayout rather than computed
    // from padding so it's exact regardless of how the row lays out.
    const [tabCenters, setTabCenters] = useState<number[]>([]);
    const handleTabLayout = (index: number, e: LayoutChangeEvent) => {
        const { x, width } = e.nativeEvent.layout;
        const center = x + width / 2;
        setTabCenters((prev) => {
            if (prev[index] === center) return prev;
            const next = prev.slice();
            next[index] = center;
            return next;
        });
    };
    // Per-tab width (centers are evenly spaced) — the range over which a tab's
    // white icon fades as the pill approaches/leaves. Derived from two adjacent
    // measured centers; falls back to 0 (boolean icon) until measured.
    const tabWidth =
        tabCenters.length >= 2 && tabCenters[0] != null && tabCenters[1] != null
            ? Math.abs(tabCenters[1] - tabCenters[0])
            : 0;

    // Sliding pill — one shared coral stadium animated via a reanimated shared
    // value off state.index. The first valid measurement positions it WITHOUT
    // animation (so it doesn't streak in from x=0 on mount); every focus
    // change after that tweens.
    const translateX = useSharedValue(0);
    const positioned = useRef(false);
    const activeCenter = tabCenters[state.index];
    useEffect(() => {
        if (activeCenter == null) return;
        const target = activeCenter - PILL_WIDTH / 2;
        if (!positioned.current) {
            translateX.value = target;
            positioned.current = true;
        } else {
            translateX.value = withTiming(target, {
                duration: SLIDE_MS,
                easing: Easing.out(Easing.cubic),
            });
        }
    }, [activeCenter, translateX]);

    const pillAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: translateX.value }],
    }));

    return (
        <View
            style={[
                styles.bar,
                { bottom: insets.bottom + FLOATING_NAV_BOTTOM_GAP },
            ]}
        >
            {/* Material: a modest blur clipped to the bar's rounded shape
                (overflow:hidden on the bar), with a high-opacity tint on top.
                The tint, not the blur, carries legibility over busy content. */}
            <BlurView
                intensity={BLUR_INTENSITY}
                tint={scheme === 'light' ? 'light' : 'dark'}
                pointerEvents="none"
                style={StyleSheet.absoluteFill}
            />
            <View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { backgroundColor: barTint }]}
            />

            {/* Sliding active pill — above the tint, behind the icons. Hidden
                until the active tab is measured so it can't flash at x=0. */}
            <Animated.View
                pointerEvents="none"
                style={[
                    styles.slidingPill,
                    {
                        backgroundColor: palette.accent,
                        opacity: activeCenter == null ? 0 : 1,
                    },
                    pillAnimatedStyle,
                ]}
            />

            {state.routes.map((route, index) => {
                const { options } = descriptors[route.key];
                const isFocused = state.index === index;

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
                    <TabItem
                        key={route.key}
                        index={index}
                        isFocused={isFocused}
                        translateX={translateX}
                        tabCenter={tabCenters[index]}
                        tabWidth={tabWidth}
                        inactiveIconColor={inactiveIconColor}
                        icon={options.tabBarIcon}
                        accessibilityLabel={accessibilityLabel}
                        onPress={onPress}
                        onLongPress={onLongPress}
                        onLayout={(e) => handleTabLayout(index, e)}
                    />
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
        // 30pt — heavily curved, near-pill (half-height would be 34).
        // Sits visually between radius.lg (24) and radius.xl (32);
        // specific to this surface, not promoted to a token until
        // another surface adopts the same value.
        borderRadius: 30,
        // Clip the blur layer to the rounded shape.
        overflow: 'hidden',
        flexDirection: 'row',
        alignItems: 'center',
        // Inner horizontal padding so the first/last tab's tap area
        // doesn't touch the bar's rounded edges.
        paddingHorizontal: spacing.sm,
    },
    // The single sliding active pill — a stadium (wider than tall). Absolutely
    // positioned; left:0 with an animated translateX to the focused tab's
    // center, vertically centered (top = (height - pillHeight) / 2).
    slidingPill: {
        position: 'absolute',
        left: 0,
        top: (FLOATING_NAV_HEIGHT - PILL_HEIGHT) / 2,
        width: PILL_WIDTH,
        height: PILL_HEIGHT,
        borderRadius: radius.full,
    },
    tab: {
        // Full-width tap target per tab (4 tabs share the bar's
        // inner width equally via flex: 1). The visual pill is a
        // smaller fixed-size element that slides between these
        // centers — bigger touch target than the pill itself.
        flex: 1,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Fixed pill-sized box the icon copies center within, so the icons line
    // up with the sliding pill's parked position.
    iconWrap: {
        width: PILL_WIDTH,
        height: PILL_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconLayer: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
