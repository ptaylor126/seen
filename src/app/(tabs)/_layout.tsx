import { Tabs } from 'expo-router';
import { BookMarked, Home, UserCircle, Users } from 'lucide-react-native';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { useSession } from '@/hooks/use-session';
import { ensurePushRegistrationOnLaunch } from '@/lib/push';
import { getPalette, ICON_STROKE_WIDTH } from '@/theme/theme';

export default function TabsLayout() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const session = useSession();
    const userId = session.session?.user.id ?? null;

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

    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                tabBarActiveTintColor: palette.accent,
                tabBarInactiveTintColor: palette.textMuted,
                tabBarStyle: {
                    // Flush at the bottom, cream background to match the
                    // rest of the app, hairline top border to delineate
                    // from content. iOS-native feel; doesn't compete
                    // with content the way the previous floating-pill
                    // BlurView did.
                    backgroundColor: palette.bg,
                    borderTopColor: palette.border,
                    borderTopWidth: 1,
                },
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: 'Home',
                    tabBarIcon: ({ color, size }) => (
                        <Home
                            color={color}
                            size={size}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="library"
                options={{
                    title: 'Library',
                    tabBarIcon: ({ color, size }) => (
                        <BookMarked
                            color={color}
                            size={size}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="friends"
                options={{
                    title: 'Friends',
                    tabBarIcon: ({ color, size }) => (
                        <Users
                            color={color}
                            size={size}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="profile"
                options={{
                    title: 'Profile',
                    tabBarIcon: ({ color, size }) => (
                        <UserCircle
                            color={color}
                            size={size}
                            strokeWidth={ICON_STROKE_WIDTH}
                        />
                    ),
                }}
            />
        </Tabs>
    );
}
