// Shared friendly load-error view. Used wherever a fetch can fail and we'd
// otherwise show a raw/technical error string (title screen, rec screen,
// search). Centred title + message + an optional "Try again" button — pass
// onRetry only when a retry can actually help (connection / transient /
// upstream failures), omit it for genuinely terminal states (no access,
// not found) so we don't dangle a button that just re-fails.
//
// `compact` trims the vertical footprint for inline contexts like the search
// results area, where a full-screen centred block would look oversized.

import {
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
} from 'react-native';

import { Text } from '@/components/text';
import { button, getPalette, radius, spacing, typography } from '@/theme/theme';

interface LoadErrorProps {
    title?: string;
    message?: string;
    onRetry?: () => void;
    compact?: boolean;
}

export function LoadError({
    title = "Couldn't load this",
    message = 'Check your connection and try again.',
    onRetry,
    compact = false,
}: LoadErrorProps) {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);

    return (
        <View style={compact ? styles.inline : styles.screen}>
            <Text
                style={[typography.bodyEmphasis, styles.title, { color: palette.text }]}
            >
                {title}
            </Text>
            <Text
                style={[typography.body, styles.message, { color: palette.textMuted }]}
            >
                {message}
            </Text>
            {onRetry ? (
                <Pressable
                    onPress={onRetry}
                    accessibilityRole="button"
                    accessibilityLabel="Try again"
                    style={({ pressed }) => [
                        styles.retryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Try again
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    screen: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
    },
    inline: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.xl,
    },
    title: { textAlign: 'center' },
    message: { textAlign: 'center', marginTop: spacing.xs },
    retryButton: {
        marginTop: spacing.lg,
        paddingVertical: button.paddingVertical,
        paddingHorizontal: spacing.xl,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
