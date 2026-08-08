import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
    CaretLeft,
} from 'phosphor-react-native';
import { useRef, useState } from 'react';
import {
    Alert,
    Keyboard,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';
import {
    KeyboardAvoidingView,
    KeyboardStickyView,
    useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
    interpolate,
    useAnimatedStyle,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import {
    OnboardingSearch,
    type SearchableItem,
} from '@/components/onboarding-search';
import { setOnboardingItemStatus } from '@/lib/onboarding-utils';
import { imageUrl } from '@/lib/tmdb';
import {
    posterFrame,
    button,
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

interface AddedItem {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title: string;
    posterPath: string;
}

// Footer height estimate (Continue ~46 + gap 8 + Skip ~44 + paddingBottom 12).
// The scroll content reserves this + the bottom inset so the last search
// result can always scroll clear of the pinned footer, in both keyboard states.
const FOOTER_CLEARANCE = 120;

export default function CurrentlyWatchingScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    // Footer clearance animated in lockstep with the KeyboardStickyView lift
    // (same keyboard progress, 0 closed → 1 open): closed the footer sits
    // insets.bottom above the screen edge via this transform, open it sits on
    // the keyboard's top edge via the sticky view — one smooth movement, no
    // overshoot. See recommend.tsx for the full rationale.
    const keyboardProgress = useReanimatedKeyboardAnimation().progress;
    const footerClearanceStyle = useAnimatedStyle(() => ({
        transform: [
            {
                translateY: interpolate(
                    keyboardProgress.value,
                    [0, 1],
                    [-insets.bottom, 0],
                ),
            },
        ],
    }));
    const scrollRef = useRef<ScrollView | null>(null);
    // y-offset of the OnboardingSearch container inside the
    // ScrollView's contentContainer — scroll the input + first result to
    // the top of the visible area when results appear.
    const searchYRef = useRef(0);

    function handleSearchLayout(y: number) {
        searchYRef.current = y;
    }

    function handleResultsRendered() {
        scrollRef.current?.scrollTo({ y: searchYRef.current, animated: true });
    }

    const [added, setAdded] = useState<AddedItem | null>(null);
    const [busy, setBusy] = useState(false);

    async function handlePick(item: SearchableItem) {
        if (busy) return;
        setBusy(true);
        Keyboard.dismiss();
        try {
            const title = item.media_type === 'movie' ? item.title : item.name;
            const rawDate =
                item.media_type === 'movie'
                    ? item.release_date
                    : item.first_air_date;
            // Shared onboarding write (upsert 'watching' + ensureTitle). Repeated
            // picks overwrite via the (user_id, tmdb_id, media_type) unique
            // constraint; rating/watched_at are nulled inside the helper so a
            // title previously added as 'watched' with a rating doesn't trip the
            // items_rating_only_when_watched_check constraint.
            await setOnboardingItemStatus(
                {
                    tmdbId: item.id,
                    mediaType: item.media_type,
                    title,
                    posterPath: item.poster_path,
                    backdropPath: item.backdrop_path,
                    releaseDate:
                        typeof rawDate === 'string' && rawDate.length > 0
                            ? rawDate
                            : null,
                    originalLanguage: item.original_language,
                    genreIds: item.genre_ids,
                },
                'watching',
            );

            setAdded({
                tmdbId: item.id,
                mediaType: item.media_type,
                title,
                posterPath: item.poster_path,
            });
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

    // Both paths advance to the poster-grid step (onboarding completes later,
    // on the final invite step).
    function handleContinue() {
        if (!added || busy) return;
        router.push('/(onboarding)/poster-grid');
    }

    function handleSkip() {
        router.push('/(onboarding)/poster-grid');
    }

    return (
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior="padding"
        >
        <SafeAreaView style={styles.root} edges={['top']}>
            <OnboardingProgress currentStep={3} totalSteps={4} />
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <CaretLeft
                        color={palette.accent}
                        size={28}
                    />
                </Pressable>
            </View>
            <ScrollView
                ref={scrollRef}
                style={styles.body}
                contentContainerStyle={[
                    styles.bodyContent,
                    // Reserve footer + safe-area room so the last result scrolls
                    // clear of the pinned footer in both keyboard states.
                    // Constant (generous when open) rather than keyboard-state-
                    // branched — simpler and robust.
                    { paddingBottom: insets.bottom + FOOTER_CLEARANCE },
                ]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
            >
                <Text style={[typography.display, { color: palette.text }]}>
                    What are you watching right now?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Friends see it on their home screen. Sometimes that&apos;s
                    all the recommendation they need.
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
                        <Image
                            source={{ uri: imageUrl(added.posterPath, 'w185') }}
                            style={styles.poster}
                            contentFit="cover"
                            transition={150}
                        />
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
                    <OnboardingSearch
                        placeholder="Search films and TV shows"
                        onPick={handlePick}
                        onResultsRendered={handleResultsRendered}
                        onContainerLayout={handleSearchLayout}
                        // Scroll the search to the top when a search starts, so
                        // the loading indicator lands above the opaque footer
                        // (results already do this via onResultsRendered).
                        onLoadingStart={handleResultsRendered}
                    />
                )}
            </ScrollView>
        </SafeAreaView>
        </KeyboardAvoidingView>
        <KeyboardStickyView style={styles.footerSticky}>
        <Animated.View
            style={[
                styles.footer,
                footerClearanceStyle,
                { backgroundColor: palette.bg },
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
        </Animated.View>
        </KeyboardStickyView>
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
        // paddingBottom (footer clearance) is applied inline on the ScrollView
        // — it needs insets.bottom + FOOTER_CLEARANCE at runtime.
    },
    confirmation: {
        padding: spacing.lg,
        borderRadius: radius.md,
        gap: spacing.md,
        marginTop: spacing.md,
        alignItems: 'center',
    },
    poster: {
        ...posterFrame,
        width: 100,
        height: 150,
        borderRadius: radius.sm,
    },
    footerSticky: {
        // KeyboardStickyView pinned to the screen bottom; lifts the footer
        // onto the keyboard's top edge when open (both platforms, animated).
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    footer: {
        // Content inside the sticky view. OPAQUE (bg set inline to palette.bg)
        // and full-width so search results scrolling behind it don't bleed
        // through — a deliberate pinned action bar, not floating buttons. The
        // scroll inset keeps rows off it; the closed-state home-indicator
        // clearance is the animated footerClearanceStyle transform.
        paddingHorizontal: spacing.base,
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        gap: spacing.sm,
    },
    primaryButton: {
        paddingVertical: button.paddingVertical,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
    skipButton: {
        alignSelf: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.sm,
    },
});
