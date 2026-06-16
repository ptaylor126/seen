import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Text, useColorScheme } from 'react-native';

import { fontFamily, getPalette } from '@/theme/theme';

interface AvatarProps {
    avatarUrl: string | null;
    displayName: string;
    /** Stable id used to pick a deterministic fallback gradient when
     *  there is no avatarUrl. Same id always gets the same pair. Pass
     *  userId if available, otherwise handle — anything stable per user. */
    seedId: string;
    size: number;
}

// djb2 — small deterministic string hash. Bounded to a 32-bit signed int
// via `| 0`; `Math.abs` because the bit-shift result can be negative.
// Same algorithm as the prior flat-colour fallback, and the modulo
// (palette.avatarFallbacks.length) is still 8 — so each existing user
// maps to the same slot as before, just rendered as a gradient now
// instead of a flat fill. Their avatar stays "their" identity.
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
    // 0.5 (up from 0.45) gives a more prominent initial — reads better
    // at the smallest sizes (20pt grid avatars where 45% was only ~9px)
    // and looks more confident at the larger profile sizes (96pt).
    const fontSize = Math.floor(size * 0.5);
    const pair =
        palette.avatarFallbacks[
            hashIndex(seedId, palette.avatarFallbacks.length)
        ];

    return (
        <LinearGradient
            colors={[pair.from, pair.to]}
            // Diagonal: top-left → bottom-right. Light source feel from
            // the upper-left; the LIGHTER stop sits in the top-left and
            // is the binding-contrast constraint for the centered white
            // initial (each pair's lighter stop is verified at ≥4.5:1
            // against white in theme.ts).
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
                width: size,
                height: size,
                borderRadius,
                alignItems: 'center',
                justifyContent: 'center',
                // overflow: 'hidden' clips the gradient to the rounded
                // shape on Android (iOS clips via borderRadius alone,
                // but Android occasionally bleeds the gradient past
                // the radius — overflow:'hidden' is the safe addition).
                overflow: 'hidden',
            }}
        >
            <Text
                style={{
                    // Geist Semibold explicitly — the prior fallback
                    // omitted fontFamily and fell through to the
                    // system default, which read off-brand against
                    // the rest of the Geist-rendered UI.
                    fontFamily: fontFamily.semibold,
                    fontSize,
                    fontWeight: '600',
                    // White in BOTH themes — every gradient's lighter
                    // stop is dark enough for white at ≥4.5:1 (see the
                    // contrast note in theme.ts). Using a fixed white
                    // rather than palette.textInverse because the new
                    // dark-theme gradients aren't bright enough for
                    // near-black text (palette.textInverse) — the
                    // colour stays consistent regardless of scheme.
                    color: '#FFFFFF',
                }}
            >
                {letter}
            </Text>
        </LinearGradient>
    );
}
