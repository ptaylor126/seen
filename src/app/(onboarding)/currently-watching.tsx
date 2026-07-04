import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { OnboardingProgress } from '@/components/onboarding-progress';
import {
    OnboardingSearch,
    type SearchableItem,
} from '@/components/onboarding-search';
import { useKeyboard } from '@/hooks/use-keyboard-open';
import { setOnboardingItemStatus } from '@/lib/onboarding-utils';
import { imageUrl } from '@/lib/tmdb';
import {
    getPalette,
    ICON_STROKE_WIDTH,
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

export default function CurrentlyWatchingScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { open: keyboardOpen, height: keyboardHeight } = useKeyboard();
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
                    What are you watching right now?
                </Text>
                <Text style={[typography.body, { color: palette.textMuted }]}>
                    Anything you&apos;re partway through? Add it so it&apos;s
                    easy to pick back up.
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
        // Footer clearance is provided by the SafeAreaView's
        // paddingBottom — this is just trailing breathing room inside
        // the scroll content.
        paddingBottom: spacing.lg,
    },
    confirmation: {
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
    footer: {
        // Absolutely positioned so the buttons snap to the keyboard's top
        // edge the moment it shows, instead of sliding up with it.
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
