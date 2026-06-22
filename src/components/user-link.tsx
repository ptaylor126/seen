/**
 * Wraps a name (and optionally an avatar) so tapping it opens that user's
 * profile via goToProfile. Pass a handle OR a userId — whichever the surface
 * has. With neither (or `disabled`), it renders an inert wrapper so the
 * caller's layout is unchanged (e.g. a deleted author with no id).
 *
 * Row-tap interception: when used INSIDE an already-tappable row (a parent
 * Pressable), React Native grants the touch responder to the inner-most
 * Pressable, so tapping the name fires THIS onPress and NOT the row's onPress.
 * Tapping anywhere else on the row still hits the row. No manual
 * stopPropagation needed — that's the gesture-responder system, not DOM
 * bubbling.
 *
 * Note: this is for block/standalone name+avatar clusters. A name rendered
 * INLINE inside a sentence <Text> can't contain a Pressable — those sites use
 * <Text onPress={() => goToProfile(...)}> instead (Text's built-in onPress
 * intercepts the row the same way).
 */
import type { ReactNode } from 'react';
import { Pressable, type StyleProp, View, type ViewStyle } from 'react-native';

import { goToProfile } from '@/lib/profile-nav';

interface UserLinkProps {
    handle?: string | null;
    userId?: string | null;
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
    hitSlop?: number;
    /** Force inert (e.g. it's the current user, or a deleted author). */
    disabled?: boolean;
    accessibilityLabel?: string;
}

export function UserLink({
    handle,
    userId,
    children,
    style,
    hitSlop,
    disabled,
    accessibilityLabel,
}: UserLinkProps) {
    const canNavigate =
        !disabled && !!(handle?.trim() || userId?.trim());

    if (!canNavigate) {
        // Inert — keep the same layout box so callers don't branch styling.
        return <View style={style}>{children}</View>;
    }

    return (
        <Pressable
            onPress={() => goToProfile({ handle, userId })}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={style}
        >
            {children}
        </Pressable>
    );
}
