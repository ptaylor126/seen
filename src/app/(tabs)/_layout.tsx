import * as Notifications from 'expo-notifications';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import FriendsIcon from '../../../assets/images/navbar/icon-friends.svg';
import HomeIcon from '../../../assets/images/navbar/icon-home.svg';
import LibraryIcon from '../../../assets/images/navbar/icon-library.svg';
import ProfileIcon from '../../../assets/images/navbar/icon-profile.svg';

import { FloatingTabBar } from '@/components/floating-tab-bar';
import { useSession } from '@/hooks/use-session';
import {
    UnreadCountProvider,
    useUnreadCountValue,
} from '@/hooks/use-unread-count';
import { ensurePushRegistrationOnLaunch } from '@/lib/push';
import { ensureInstallTimestamp } from '@/lib/review';

// Icon-badge sync — the ONE place that writes the OS app-icon badge. Rendered
// as a child of UnreadCountProvider so it reads the SAME shared count state
// the tab-screen bells render (useUnreadCountValue = context read, no focus
// registration): whatever updates a bell — a screen's focus refetch, any
// realtime event, foreground — updates the icon in the same render pass, by
// construction. This replaced the layout's own useUnreadCount instance, whose
// private copy of the count could sit stale at the old value while the tab
// instances (and bells) moved on — bell dropped, icon stayed pinned.
// setBadgeCountAsync is JS-only over the already-bundled expo-notifications
// native module, so this is OTA-safe. A value of 0 clears the badge. Gated on
// `loaded` so we never write the placeholder 0 before the first real fetch
// resolves — otherwise a launch with an existing push badge would flash to 0
// and back.
function IconBadgeSync() {
    const { count, loaded } = useUnreadCountValue();
    useEffect(() => {
        if (!loaded) return;
        void Notifications.setBadgeCountAsync(count);
    }, [loaded, count]);
    // Re-assert on foreground: the on-change effect above only fires when
    // `count` changes, so a badge altered behind the app's back (iOS zeroing
    // it on a newly-granted permission, a push setting an absolute number)
    // stays wrong until the count happens to move. Rewriting the current
    // count on every AppState 'active' corrects it on return. Gated on
    // `loaded` so we never assert the placeholder 0.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active' && loaded) {
                void Notifications.setBadgeCountAsync(count);
            }
        });
        return () => sub.remove();
    }, [loaded, count]);
    return null;
}

export default function TabsLayout() {
    const session = useSession();
    const userId = session.session?.user.id ?? null;

    // Push registration on entry to the authenticated app. (tabs) is
    // only reachable post-auth + post-onboarding (root layout's routing
    // effect enforces this), so by the time we fire here we have a
    // real user.
    //
    // Brief settle delay so the route transition into (tabs) finishes
    // before this fires — it defers the token read + push_tokens network
    // write off the transition so the first second in the app isn't
    // sharing a frame budget with a mid-transition async burst. Cleanup
    // cancels the pending attempt if TabsLayout unmounts within the
    // window (sign out, etc.) so we don't write a stale user's token.
    // The module-level guard inside ensurePushRegistrationOnLaunch
    // handles repeat-mount safety beyond that window. Idempotent
    // across cold launches via savePushToken's upsert on
    // (user_id, device_id).
    //
    // Behaviour per permission state inside the helper — it NEVER prompts on
    // launch (registerForPushNotifications returns null unless permission is
    // ALREADY granted; see push.ts):
    //   - granted      → silently get the Expo token + upsert push_tokens row
    //                    (re-registers established users; fixes new-device)
    //   - undetermined → no-op: no token, no Alert, no system prompt. The
    //                    prompt is reserved for a high-intent moment
    //                    (promptPushAtHighIntent: send a rec / accept a
    //                    friend), never burned on launch.
    //   - denied       → no-op (the OS won't re-show the prompt)
    useEffect(() => {
        if (!userId) return;
        // Stamp the review-prompt install timestamp at app entry (was implicit
        // in the old every-Home-focus trigger call; the trigger is event-based
        // now — see review.ts — but the ts must still be born at FIRST LAUNCH
        // so the first-session guard keeps its meaning). No-op after the
        // first ever launch; cheap AsyncStorage read, no settle delay needed.
        void ensureInstallTimestamp();
        const timer = setTimeout(() => {
            void ensurePushRegistrationOnLaunch(userId);
        }, 800);
        return () => clearTimeout(timer);
    }, [userId]);

    return (
        // ONE shared unread-count instance for everything under (tabs): the
        // four tab screens consume it for their bells (useUnreadCount — same
        // call sites as before, now context reads + per-screen focus
        // triggers) and IconBadgeSync mirrors the identical state onto the
        // OS icon. One state, one realtime channel, one RPC per event —
        // bell and badge cannot diverge.
        <UnreadCountProvider>
            <IconBadgeSync />
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
        </UnreadCountProvider>
    );
}
