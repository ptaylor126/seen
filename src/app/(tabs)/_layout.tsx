import { Tabs } from 'expo-router';
import { BookMarked, Home, UserCircle, Users } from 'lucide-react-native';
import { useColorScheme } from 'react-native';

import { getPalette } from '@/theme/theme';

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
                    backgroundColor: palette.bg,
                    borderTopColor: palette.border,
                },
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: 'Home',
                    tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
                }}
            />
            <Tabs.Screen
                name="library"
                options={{
                    title: 'Library',
                    tabBarIcon: ({ color, size }) => <BookMarked color={color} size={size} />,
                }}
            />
            <Tabs.Screen
                name="friends"
                options={{
                    title: 'Friends',
                    tabBarIcon: ({ color, size }) => <Users color={color} size={size} />,
                }}
            />
            <Tabs.Screen
                name="profile"
                options={{
                    title: 'Profile',
                    tabBarIcon: ({ color, size }) => <UserCircle color={color} size={size} />,
                }}
            />
        </Tabs>
    );
}
