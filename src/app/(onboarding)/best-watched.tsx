import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { ChevronLeft, Star } from 'lucide-react-native';
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

interface PickedItem {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title: string;
}

const STAR_SIZE = 40;

export default function BestWatchedScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const keyboardOpen = useKeyboardOpen();

    const [picked, setPicked] = useState<PickedItem | null>(null);
    const [rating, setRating] = useState<number | null>(null);
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
            // Insert as watched with no rating yet — rating comes next
            // and updates this same row via the unique constraint.
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
            setPicked({ tmdbId: item.id, mediaType: item.media_type, title });
            setRating(null);
        } catch (err) {
            console.error('best-watched add failed:', err);
            Alert.alert(
                "Couldn't add",
                err instanceof Error ? err.message : 'Unknown error',
            );
        } finally {
            setBusy(false);
        }
    }

    async function setStarsRating(value: number) {
        // Toggle off if tapping the currently-selected star.
        const newRating = rating === value ? null : value;
        setRating(newRating);
        // Light haptic on each rating change — same Letterboxd-style
        // feel the modal sheet uses.
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (!picked) return;
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) return;
            // Persist rating + the derived rating_thumb on any matching
            // open recs (mirrors applyWatchedRating in lib/rating, but
            // simpler since onboarding never has open recs yet).
            await supabase
                .from('items')
                .update({ rating: newRating })
                .eq('user_id', userId)
                .eq('tmdb_id', picked.tmdbId)
                .eq('media_type', picked.mediaType);
        } catch (err) {
            console.warn('best-watched rating save failed:', err);
        }
    }

    function handleContinue() {
        router.push('/(onboarding)/currently-watching');
    }

    function handleSkip() {
        // Advance to the next step, not finish onboarding. Only the
        // final step (currently-watching) flips the onboarded flag.
        router.push('/(onboarding)/currently-watching');
    }

    const canContinue = picked !== null && rating !== null && !busy;

    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: palette.bg }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <OnboardingProgress currentStep={5} totalSteps={6} />
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
                    What&apos;s the best thing you&apos;ve watched recently?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Friends will see your favourites.
                </Text>
                {picked ? (
                    <View
                        style={[
                            styles.pickedCard,
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
                            {picked.title}
                        </Text>
                        <View style={styles.starsRow}>
                            {[1, 2, 3, 4, 5].map((value) => {
                                const filled = rating !== null && value <= rating;
                                const color = filled
                                    ? palette.accent
                                    : palette.textMuted;
                                return (
                                    <Pressable
                                        key={value}
                                        onPress={() => setStarsRating(value)}
                                        hitSlop={spacing.xs}
                                        style={({ pressed }) => [
                                            styles.starButton,
                                            { opacity: pressed ? 0.6 : 1 },
                                        ]}
                                    >
                                        <Star
                                            color={color}
                                            fill={filled ? palette.accent : 'transparent'}
                                            size={STAR_SIZE}
                                        />
                                    </Pressable>
                                );
                            })}
                        </View>
                        <Pressable
                            onPress={() => {
                                setPicked(null);
                                setRating(null);
                            }}
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
                    disabled={!canContinue}
                    style={({ pressed }) => [
                        styles.primaryButton,
                        {
                            backgroundColor: palette.accent,
                            opacity: !canContinue ? 0.4 : pressed ? 0.6 : 1,
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
    pickedCard: {
        padding: spacing.lg,
        borderRadius: radius.md,
        gap: spacing.md,
        marginTop: spacing.md,
        alignItems: 'center',
    },
    starsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    starButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
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
