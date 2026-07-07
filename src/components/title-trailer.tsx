import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { ChevronRight, Play } from 'lucide-react-native';
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

// Trailer affordance for the title screen: one full-width, settings-style row —
// thumbnail (left) + "Watch trailer" (fills the middle) + a chevron pinned to
// the right edge, the whole thing a single pressable. Tapping opens the video
// in the YouTube app or browser (deep-link — no in-app embed). Selects the best
// trailer from the title's videos and renders NOTHING when none qualifies. If
// the thumbnail fails to load it drops to the same row minus the thumbnail, so
// the screen never shows a broken/blank image.
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
            {!thumbFailed && (
                // Shape (b): thumbnail with a play badge overlay. On load error
                // it's dropped entirely (fallback shape a — same row, no thumb).
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
            <Text
                style={[
                    typography.bodyEmphasis,
                    styles.label,
                    { color: palette.text },
                ]}
            >
                Watch trailer
            </Text>
            <ChevronRight
                color={palette.textMuted}
                size={20}
                strokeWidth={ICON_STROKE_WIDTH}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        // Match the surrounding content inset (tagline / synopsis) and the
        // settings-row rhythm; marginTop mirrors the siblings' spacing so the
        // row sits evenly between the meta block above and the synopsis below.
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.md,
        marginTop: spacing.base,
    },
    // Fills the middle so the chevron pins to the right edge — full-width row.
    label: { flex: 1 },
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
});
