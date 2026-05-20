import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import {
    Alert,
    Keyboard,
    Pressable,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingDots } from '@/components/onboarding-dots';
import {
    OnboardingSearch,
    type SearchableItem,
} from '@/components/onboarding-search';
import { useProfile } from '@/hooks/use-profile';
import { finishOnboarding } from '@/lib/onboarding-utils';
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
    const { refresh: refreshProfile } = useProfile();

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

    async function handleSkip() {
        await finishOnboarding({
            onComplete: () => router.replace('/(tabs)'),
            refreshProfile,
        });
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top', 'bottom']}
        >
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
            <View style={styles.footer}>
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
                <OnboardingDots currentStep={4} totalSteps={6} />
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: { paddingVertical: spacing.sm },
    body: {
        flex: 1,
        gap: spacing.md,
        paddingTop: spacing.lg,
    },
    searchWrap: {
        flex: 1,
        marginTop: spacing.md,
    },
    confirmation: {
        padding: spacing.md,
        borderRadius: radius.sm,
        gap: spacing.xs,
    },
    footer: {
        gap: spacing.sm,
        paddingBottom: spacing.md,
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
