import { Tabs } from 'expo-router';
import { BookMarked, Home, UserCircle, Users } from 'lucide-react-native';
import { useColorScheme } from 'react-native';

import { getPalette, ICON_STROKE_WIDTH } from '@/theme/theme';

export default function TabsLayout() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

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
