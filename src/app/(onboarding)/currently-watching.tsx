import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
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
import { useKeyboardOpen } from '@/hooks/use-keyboard-open';
import { useProfile } from '@/hooks/use-profile';
import { finishOnboarding } from '@/lib/onboarding-utils';
import supabase from '@/lib/supabase';
import { imageUrl } from '@/lib/tmdb';
import { getPalette, radius, spacing, typography } from '@/theme/theme';

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
    const keyboardOpen = useKeyboardOpen();
    const scrollRef = useRef<ScrollView | null>(null);
    // y-offset of the OnboardingSearch container — see last-watched.tsx.
    const searchYRef = useRef(0);
    const { refresh: refreshProfile } = useProfile();

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
            //
            // rating + watched_at are explicitly nulled: if the same show
            // was added in a prior onboarding step as 'watched' with a
            // rating, the items_rating_only_when_watched_check constraint
            // would fail on the status='watching' transition unless we
            // clear them here.
            const { error } = await supabase.from('items').upsert(
                {
                    user_id: userId,
                    tmdb_id: item.id,
                    media_type: item.media_type,
                    status: 'watching',
                    rating: null,
                    watched_at: null,
                },
                { onConflict: 'user_id,tmdb_id,media_type' },
            );
            if (error) throw error;
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
    },
    bodyContent: {
        gap: spacing.md,
        paddingTop: spacing.lg,
        // Generous bottom padding — see last-watched.tsx for rationale.
        paddingBottom: spacing.xxl,
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
        // paddingBottom is set inline — see last-watched.tsx for
        // rationale (LayoutAnimation drives the open/closed transition
        // in sync with the keyboard slide).
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
