import { Image } from 'expo-image';
import { Text, useColorScheme, View } from 'react-native';

import { getPalette } from '@/theme/theme';

interface AvatarProps {
    avatarUrl: string | null;
    displayName: string;
    /** Stable id used to pick a deterministic fallback colour when there
     *  is no avatarUrl. Same id always gets the same colour. Pass userId
     *  if available, otherwise handle — anything stable per user. */
    seedId: string;
    size: number;
}

// djb2 — small deterministic string hash. Bounded to a 32-bit signed int
// via `| 0`; `Math.abs` because the bit-shift result can be negative.
function hashIndex(seed: string, modulo: number): number {
    let h = 5381;
    for (let i = 0; i < seed.length; i++) {
        h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % modulo;
}

export function Avatar({ avatarUrl, displayName, seedId, size }: AvatarProps) {
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
    const fallbacks = palette.avatarFallbacks;
    const backgroundColor = fallbacks[hashIndex(seedId, fallbacks.length)];

    return (
        <View
            style={{
                width: size,
                height: size,
                borderRadius,
                backgroundColor,
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
