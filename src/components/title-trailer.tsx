import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Play } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { selectTrailerKey, type TMDBVideo } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

// Compact 16:9 thumbnail, one row-height. YouTube's hqdefault always exists
// for a valid video (so it won't 404 into a false fallback); cover-crop hides
// its letterbox bars.
const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 54;

// Trailer affordance for the title screen: a small YouTube thumbnail with a
// play badge + "Watch trailer", tapping opens the video in the YouTube app or
// browser (deep-link — no in-app embed). Selects the best trailer from the
// title's videos and renders NOTHING when none qualifies. If the thumbnail
// fails to load it falls back to a plain "Watch trailer" row (shape a) so the
// screen never shows a broken/blank image.
export function TitleTrailer({ videos }: { videos: TMDBVideo[] | undefined }) {
    const videoKey = useMemo(() => selectTrailerKey(videos), [videos]);
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const [thumbFailed, setThumbFailed] = useState(false);

    if (!videoKey) return null;

    function open() {
        // Same pattern as the JustWatch button: the OS routes the https URL to
        // the YouTube app if installed, else the browser.
        Linking.openURL(`https://www.youtube.com/watch?v=${videoKey}`).catch(
            (err) => console.warn('open trailer failed:', err),
        );
    }

    return (
        <Pressable
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel="Watch trailer"
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
        >
            {thumbFailed ? (
                // Fallback shape (a): plain play badge, no thumbnail.
                <View
                    style={[
                        styles.iconBadge,
                        { backgroundColor: palette.accent },
                    ]}
                >
                    <Play
                        color={palette.textInverse}
                        size={16}
                        strokeWidth={ICON_STROKE_WIDTH}
                        fill={palette.textInverse}
                    />
                </View>
            ) : (
                // Shape (b): thumbnail with a play badge overlay.
                <View style={styles.thumbWrap}>
                    <Image
                        source={{
                            uri: `https://img.youtube.com/vi/${videoKey}/hqdefault.jpg`,
                        }}
                        style={[
                            styles.thumb,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                        contentFit="cover"
                        transition={150}
                        onError={() => setThumbFailed(true)}
                    />
                    <View style={styles.playOverlay} pointerEvents="none">
                        <View style={styles.playBadge}>
                            <Play
                                color="#FFFFFF"
                                size={16}
                                strokeWidth={ICON_STROKE_WIDTH}
                                fill="#FFFFFF"
                            />
                        </View>
                    </View>
                </View>
            )}
            <Text style={[typography.bodyEmphasis, { color: palette.text }]}>
                Watch trailer
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    thumbWrap: {
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
    },
    thumb: {
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        borderRadius: radius.sm,
    },
    playOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    playBadge: {
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconBadge: {
        width: THUMB_HEIGHT,
        height: THUMB_HEIGHT,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
