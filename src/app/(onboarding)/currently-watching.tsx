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
import { useProfile } from '@/hooks/use-profile';
import { finishOnboarding } from '@/lib/onboarding-utils';
import supabase from '@/lib/supabase';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

interface AddedItem {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title: string;
}

export default function CurrentlyWatchingScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const keyboardOpen = useKeyboardOpen();
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
            // Repeated picks overwrite via the (user_id, tmdb_id, media_type)
            // unique constraint — last pick wins, matching the visible
            // confirmation. The user can re-pick freely without leaving
            // a trail of half-committed rows.
            const { error } = await supabase.from('items').upsert(
                {
                    user_id: userId,
                    tmdb_id: item.id,
                    media_type: item.media_type,
                    status: 'watching',
                },
                { onConflict: 'user_id,tmdb_id,media_type' },
            );
            if (error) throw error;
            setAdded({ tmdbId: item.id, mediaType: item.media_type, title });
        } catch (err) {
            console.error('currently-watching add failed:', err);
            Alert.alert(
                "Couldn't add",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleContinue() {
        if (!added || busy) return;
        await finishOnboarding({ refreshProfile });
    }

    async function handleSkip() {
        await finishOnboarding({ refreshProfile });
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
            <OnboardingProgress currentStep={6} totalSteps={6} />
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
                    What are you watching right now?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Anything you&apos;re in the middle of? Add it —
                    we&apos;ll keep track.
                </Text>
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
                        <Pressable
                            onPress={() => setAdded(null)}
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                        >
                            <Text style={[typography.caption, { color: palette.accent }]}>
                                Pick something else
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <View style={styles.searchWrap}>
                        <OnboardingSearch
                            placeholder="Search films and TV shows"
                            onPick={handlePick}
                        />
                    </View>
                )}
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
        // minHeight:0 — see last-watched.tsx for the rationale; lets
        // the OnboardingSearch's FlatList shrink instead of overflowing
        // the footer when the keyboard pushes things up.
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
        padding: spacing.lg,
        borderRadius: radius.md,
        gap: spacing.md,
        marginTop: spacing.md,
        alignItems: 'center',
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
