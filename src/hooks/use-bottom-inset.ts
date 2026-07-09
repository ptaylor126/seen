import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from '@/theme/theme';

// Bottom padding for scroll content on PUSHED screens (no floating tab bar) so
// content clears the Android system navigation bar / iOS home indicator. Adds
// the safe-area bottom inset to a breathing-room token; Math.max keeps the full
// token even on devices that report a 0 bottom inset (defensive — same pattern
// title/[tmdbId] uses inline). Tab screens use useFloatingTabBarInset instead.
export function useBottomInset(extra: number = spacing.lg): number {
    const insets = useSafeAreaInsets();
    return Math.max(insets.bottom + extra, extra);
}
