import { Image } from 'expo-image';
import { Text, useColorScheme, View } from 'react-native';

import { getPalette } from '@/theme/theme';

interface AvatarProps {
    avatarUrl: string | null;
    displayName: string;
    size: number;
}

export function Avatar({ avatarUrl, displayName, size }: AvatarProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const borderRadius = size / 2;

    if (avatarUrl) {
        return (
            <Image
                source={{ uri: avatarUrl }}
                style={{
                    width: size,
                    height: size,
                    borderRadius,
                    backgroundColor: palette.accent,
                }}
                contentFit="cover"
                transition={150}
            />
        );
    }

    const letter = displayName[0]?.toUpperCase() ?? '?';
    const fontSize = Math.floor(size * 0.45);

    return (
        <View
            style={{
                width: size,
                height: size,
                borderRadius,
                backgroundColor: palette.accent,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Text
                style={{
                    fontSize,
                    fontWeight: '600',
                    color: palette.textInverse,
                }}
            >
                {letter}
            </Text>
        </View>
    );
}
