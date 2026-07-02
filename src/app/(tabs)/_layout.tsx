import * as Notifications from 'expo-notifications';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';

import FriendsIcon from '../../../assets/images/navbar/icon-friends.svg';
import HomeIcon from '../../../assets/images/navbar/icon-home.svg';
import LibraryIcon from '../../../assets/images/navbar/icon-library.svg';
import ProfileIcon from '../../../assets/images/navbar/icon-profile.svg';

import { FloatingTabBar } from '@/components/floating-tab-bar';
import { useSession } from '@/hooks/use-session';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { ensurePushRegistrationOnLaunch } from '@/lib/push';

export default function TabsLayout() {
    const session = useSession();
    const userId = session.session?.user.id ?? null;

    // Single unread-count instance that drives the OS app-icon badge (see the
    // sync effect below). The four tab screens each run their own
    // useUnreadCount to render the in-app bell; this one exists ONLY to own
    // the icon-badge sync from one place, rather than firing setBadgeCountAsync
    // from inside the hook (which is mounted 4×).
    const { count: unreadCount, loaded: unreadLoaded } = useUnreadCount();

    // Push registration on entry to the authenticated app. (tabs) is
    // only reachable post-auth + post-onboarding (root layout's routing
    // effect enforces this), so by the time we fire here we have a
    // real user.
    //
    // Brief settle delay so the route transition into (tabs) finishes
    // before the explainer Alert can slam up — the first second in the
    // app shouldn't be blocked by a modal mid-transition. Cleanup
    // cancels the pending attempt if TabsLayout unmounts within the
    // window (sign out, etc.) so we don't write a stale user's token.
    // The module-level guard inside ensurePushRegistrationOnLaunch
    // handles repeat-mount safety beyond that window. Idempotent
    // across cold launches via savePushToken's upsert on
    // (user_id, device_id).
    //
    // Behaviour per permission state inside the helper:
    //   - granted     → silently get token + upsert push_tokens row
    //                   (re-registers established users; fixes the
    //                   new-device case)
    //   - undetermined → askPushExplainer Alert → system prompt →
    //                    upsert on grant (catches users who never
    //                    accepted a friend request)
    //   - denied      → no-op (iOS won't re-show the prompt)
    useEffect(() => {
        if (!userId) return;
        const timer = setTimeout(() => {
            void ensurePushRegistrationOnLaunch(userId);
        }, 800);
        return () => clearTimeout(timer);
    }, [userId]);

    // Icon-badge sync — the ONE place that writes the OS app-icon badge.
    // useUnreadCount already recomputes `count` on screen focus, on
    // app-foreground (AppState 'active'), and on realtime changes; mirroring
    // it here keeps the icon badge in step with the in-app bell while the app
    // is open, and reconciles anything the closed-app push badge missed (e.g. a
    // friend request, which doesn't push). setBadgeCountAsync is JS-only over
    // the already-bundled expo-notifications native module, so this is
    // OTA-safe. A value of 0 clears the badge. Gated on `loaded` so we never
    // write the placeholder 0 before the first real fetch resolves — otherwise
    // a launch with an existing push badge would flash to 0 and back.
    useEffect(() => {
        if (!unreadLoaded) return;
        void Notifications.setBadgeCountAsync(unreadCount);
    }, [unreadLoaded, unreadCount]);

    return (
        <Tabs
            // Custom floating tab bar — see src/components/floating-tab-bar.tsx
            // for the rounded, inset, image-forward design. The tabBar
            // function receives BottomTabBarProps from React Navigation;
            // the component owns colour, layout, and active-state pill,
            // so the per-Tabs.Screen tabBarActiveTintColor / Inactive /
            // tabBarStyle options no longer apply (they're owned by
            // the default tab bar that we've replaced).
            tabBar={(props) => <FloatingTabBar {...props} />}
            screenOptions={{
                headerShown: false,
            }}
        >
            {/* Custom Figma nav icons (assets/images/navbar/). The
                color prop resolves the SVGs' `stroke="currentColor"`
                so the tab bar's tabBarActiveTintColor /
                tabBarInactiveTintColor (plum / textMuted) recolour
                each icon automatically. width/height take react
                navigation's size token. strokeWidth not passed —
                each SVG bakes its own stroke (1.2 as exported from
                Figma; design pass may bump to ICON_STROKE_WIDTH=1.5
                later). */}
            <Tabs.Screen
                name="index"
                options={{
                    title: 'Home',
                    tabBarIcon: ({ color, size }) => (
                        <HomeIcon color={color} width={size} height={size} />
                    ),
                }}
            />
            <Tabs.Screen
                name="library"
                options={{
                    title: 'Library',
                    tabBarIcon: ({ color, size }) => (
                        <LibraryIcon color={color} width={size} height={size} />
                    ),
                }}
            />
            <Tabs.Screen
                name="friends"
                options={{
                    title: 'Friends',
                    tabBarIcon: ({ color, size }) => (
                        <FriendsIcon color={color} width={size} height={size} />
                    ),
                }}
            />
            <Tabs.Screen
                name="profile"
                options={{
                    title: 'Profile',
                    tabBarIcon: ({ color, size }) => (
                        <ProfileIcon color={color} width={size} height={size} />
                    ),
                }}
            />
        </Tabs>
    );
}
