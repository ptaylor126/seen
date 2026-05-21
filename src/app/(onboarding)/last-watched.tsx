import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import {
    Alert,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import {
    OnboardingSearch,
    type SearchableItem,
} from '@/components/onboarding-search';
import { useKeyboardOpen } from '@/hooks/use-keyboard-open';
import supabase from '@/lib/supabase';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

interface AddedItem {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title: string;
}

export default function LastWatchedScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const keyboardOpen = useKeyboardOpen();

    const [added, setAdded] = useState<AddedItem | null>(null);
    const [busy, setBusy] = useState(false);

    async function handlePick(item: SearchableItem) {
        if (busy) return;
        setBusy(true);
        Keyboard.dismiss();
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            const title = item.media_type === 'movie' ? item.title : item.name;
            const { error } = await supabase.from('items').upsert(
                {
                    user_id: userId,
                    tmdb_id: item.id,
                    media_type: item.media_type,
                    status: 'watched',
                    watched_at: new Date().toISOString(),
                },
                { onConflict: 'user_id,tmdb_id,media_type' },
            );
            if (error) throw error;

            setAdded({ tmdbId: item.id, mediaType: item.media_type, title });
        } catch (err) {
            console.error('last-watched add failed:', err);
            Alert.alert(
                "Couldn't add",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    function handleContinue() {
        router.push('/(onboarding)/best-watched');
    }

    function handleSkip() {
        // Advance to the next step, not finish onboarding. Only the
        // final step (currently-watching) flips the onboarded flag.
        router.push('/(onboarding)/best-watched');
    }

    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: palette.bg }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <OnboardingProgress currentStep={4} totalSteps={6} />
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <ChevronLeft color={palette.accent} size={28} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <Text style={[typography.display, { color: palette.text }]}>
                    What did you last watch?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Just one thing to get started. Search and tap to add it.
                </Text>
                <View style={styles.searchWrap}>
                    <OnboardingSearch
                        placeholder="Search films and TV shows"
                        onPick={handlePick}
                    />
                </View>
                {added ? (
                    <View
                        style={[
                            styles.confirmation,
                            { backgroundColor: palette.surfaceAlt },
                        ]}
                    >
                        <Text style={[typography.caption, { color: palette.textMuted }]}>
                            Added
                        </Text>
                        <Text
                            style={[typography.bodyEmphasis, { color: palette.text }]}
                            numberOfLines={2}
                        >
                            {added.title}
                        </Text>
                    </View>
                ) : null}
            </View>
            <View
                style={[
                    styles.footer,
                    {
                        paddingBottom: keyboardOpen
                            ? spacing.md
                            : insets.bottom + spacing.md,
                    },
                ]}
            >
                <Pressable
                    onPress={handleContinue}
                    disabled={!added || busy}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: !added || busy ? 0.4 : pressed ? 0.6 : 1,
                        },
                    ]}
                >
                    <Text
                        style={[
                            typography.bodyEmphasis,
                            { color: palette.textInverse },
                        ]}
                    >
                        Continue
                    </Text>
                </Pressable>
                <Pressable
                    onPress={handleSkip}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [
                        styles.skipButton,
                        { opacity: pressed ? 0.6 : 1 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        Skip
                    </Text>
                </Pressable>
            </View>
        </SafeAreaView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: { paddingVertical: spacing.sm },
    body: {
        flex: 1,
        // minHeight:0 propagates the shrink-when-pushed behaviour from
        // OnboardingSearch up through this column — without it, the
        // body grows to its content height and overlaps the footer.
        minHeight: 0,
        gap: spacing.md,
        paddingTop: spacing.lg,
    },
    searchWrap: {
        flex: 1,
        minHeight: 0,
        marginTop: spacing.md,
    },
    confirmation: {
        padding: spacing.md,
        borderRadius: radius.sm,
        gap: spacing.xs,
    },
    footer: {
        // paddingBottom is set inline based on keyboard state — see
        // handle.tsx for the rationale.
        gap: spacing.sm,
    },
    primaryButton: {
        paddingVertical: spacing.md,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
