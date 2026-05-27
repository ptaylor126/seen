import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronLeft, Star } from 'lucide-react-native';
import { useRef, useState } from 'react';
import {
    Alert,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
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
import { useKeyboard } from '@/hooks/use-keyboard-open';
import supabase from '@/lib/supabase';
import { imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface PickedItem {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title: string;
    posterPath: string;
}

const STAR_SIZE = 40;

export default function BestWatchedScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { open: keyboardOpen, height: keyboardHeight } = useKeyboard();
    const scrollRef = useRef<ScrollView | null>(null);
    // y-offset of the OnboardingSearch container inside the
    // ScrollView's contentContainer. Captured once on layout, then
    // used to scroll the input + first result to the top of the
    // visible area when results appear (rather than scrolling to the
    // bottom of the list).
    const searchYRef = useRef(0);

    function handleSearchLayout(y: number) {
        searchYRef.current = y;
    }

    function handleResultsRendered() {
        scrollRef.current?.scrollTo({ y: searchYRef.current, animated: true });
    }

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
            setPicked({
                tmdbId: item.id,
                mediaType: item.media_type,
                title,
                posterPath: item.poster_path,
            });
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
        // Stored rating is on the 1-10 half-star scale; the onboarding
        // picker only exposes whole stars, so a tap on visible star N
        // maps to value * 2 (star 5 → 10 stored). Toggle off if the
        // user re-taps the currently-selected star.
        const wholeStarValue = value * 2;
        const newRating = rating === wholeStarValue ? null : wholeStarValue;
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
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <SafeAreaView
            style={[
                styles.root,
                {
                    // Reserves space at the bottom of SAV so the
                    // ScrollView's visible viewport ends ABOVE the
                    // absolutely-positioned footer (instead of running
                    // under it). 120 = approximate footer height
                    // (Continue 44 + gap 8 + Skip 36 + ~32 breathing
                    // room) + spacing.md gap to keyboard/inset.
                    paddingBottom: keyboardOpen
                        ? 120
                        : insets.bottom + 120,
                },
            ]}
            edges={['top']}
        >
            <OnboardingProgress currentStep={3} totalSteps={4} />
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <ChevronLeft
                        color={palette.accent}
                        size={28}
                        strokeWidth={ICON_STROKE_WIDTH}
                    />
                </Pressable>
            </View>
            <ScrollView
                ref={scrollRef}
                style={styles.body}
                contentContainerStyle={styles.bodyContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
            >
                <Text style={[typography.display, { color: palette.text }]}>
                    Watched anything good lately?
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
                        <Image
                            source={{ uri: imageUrl(picked.posterPath, 'w185') }}
                            style={styles.poster}
                            contentFit="cover"
                            transition={150}
                        />
                        <Text
                            style={[typography.bodyEmphasis, { color: palette.text }]}
                            numberOfLines={2}
                        >
                            {picked.title}
                        </Text>
                        <View style={styles.starsRow}>
                            {[1, 2, 3, 4, 5].map((value) => {
                                // rating is stored on the 1-10 half-star
                                // scale; visible star N is "filled" when
                                // the stored value is >= N * 2.
                                const filled =
                                    rating !== null && rating >= value * 2;
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
                                            strokeWidth={ICON_STROKE_WIDTH}
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
                    <OnboardingSearch
                        placeholder="Search films and TV shows"
                        onPick={handlePick}
                        onResultsRendered={handleResultsRendered}
                        onContainerLayout={handleSearchLayout}
                    />
                )}
            </ScrollView>
        </SafeAreaView>
        </KeyboardAvoidingView>
        <View
            style={[
                styles.footer,
                {
                    bottom: keyboardOpen
                        ? keyboardHeight + spacing.md
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
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, paddingHorizontal: spacing.base },
    header: { paddingVertical: spacing.sm },
    body: {
        flex: 1,
    },
    bodyContent: {
        gap: spacing.md,
        paddingTop: spacing.lg,
        // Trailing breathing room inside the scroll content; footer
        // clearance is provided by the SafeAreaView's paddingBottom.
        paddingBottom: spacing.lg,
    },
    pickedCard: {
        padding: spacing.lg,
        borderRadius: radius.md,
        gap: spacing.md,
        marginTop: spacing.md,
        alignItems: 'center',
    },
    poster: {
        width: 100,
        height: 150,
        borderRadius: radius.sm,
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
        // Absolutely positioned so the Continue + Skip buttons snap to
        // the top edge of the keyboard the moment keyboardWillShow
        // fires, instead of sliding up alongside the keyboard. `bottom`
        // is set inline: keyboardHeight + spacing.md when open,
        // insets.bottom + spacing.md when closed (clears home
        // indicator).
        position: 'absolute',
        left: spacing.base,
        right: spacing.base,
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
