/**
 * The profile tab's icon: the signed-in user's avatar instead of a
 * glyph. Reads the shared ProfileProvider context (the same one the
 * Profile tab header and /profile/edit's refresh() write to), so a
 * photo change propagates here in the same render pass with no
 * refetch and no restart.
 *
 * Active state: fill-vs-linear can't apply to a photo, so the tab
 * bar's two-layer cross-fade renders this twice — the resting layer
 * (focused=false, hairline border-token edge ring for definition over
 * the translucent bar) and the on-pill layer (focused=true, 2pt accent
 * ring) — and the pill's slide fades the accent ring in. The outer box
 * is constant across states, so the layers align and nothing shifts
 * while the photo loads (the shared Avatar's initial-fallback circle
 * renders in the identical frame meanwhile).
 */
import { UserCircle } from 'phosphor-react-native';
import { StyleSheet, View, useColorScheme } from 'react-native';

import { Avatar } from '@/components/avatar';
import { useProfile } from '@/hooks/use-profile';
import { getPalette } from '@/theme/theme';

const AVATAR_SIZE = 26;
const ACTIVE_RING_WIDTH = 2;
// Avatar + ring on both sides. Constant in BOTH states — at rest the
// ring slot is transparent, so active only recolours it.
const OUTER_SIZE = AVATAR_SIZE + ACTIVE_RING_WIDTH * 2;

export function ProfileTabAvatar({
    focused,
    color,
    size,
}: {
    focused: boolean;
    color: string;
    size: number;
}) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const { profile } = useProfile();

    if (!profile) {
        // Pre-resolve flash (cold launch before the profile row lands):
        // keep the glyph the tab shipped with rather than an empty "?"
        // circle that reads as a failure.
        return (
            <UserCircle
                color={color}
                size={size}
                weight={focused ? 'fill' : 'regular'}
            />
        );
    }

    return (
        <View
            style={[
                styles.outer,
                focused && { borderColor: palette.accent },
            ]}
        >
            {/* Hairline edge ring directly on the photo bound — present in
                both states (it sits inside the accent ring when active) so
                the photo always has definition over the translucent bar. */}
            <View style={[styles.edge, { borderColor: palette.border }]}>
                <Avatar
                    avatarUrl={profile.avatarUrl}
                    displayName={profile.displayName}
                    seedId={profile.id}
                    size={AVATAR_SIZE}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    outer: {
        width: OUTER_SIZE,
        height: OUTER_SIZE,
        borderRadius: OUTER_SIZE / 2,
        borderWidth: ACTIVE_RING_WIDTH,
        borderColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
    },
    edge: {
        borderRadius: AVATAR_SIZE / 2 + StyleSheet.hairlineWidth,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
});
