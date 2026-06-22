import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Keyboard,
    Platform,
    Pressable,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    useColorScheme,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { useKeyboard } from '@/hooks/use-keyboard-open';
import supabase from '@/lib/supabase';
import { getMovie, getTV, imageUrl, type TMDBMovie, type TMDBTV } from '@/lib/tmdb';
import {
    getPalette,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

type MediaType = 'movie' | 'tv';
// Item visibility values that exist post-migration 20260607140000. The
// CHECK currently allows only these two; a future 'public' tier would
// extend both the DB CHECK and this union.
type Visibility = 'friends' | 'private';

const REVIEW_MAX_LENGTH = 2000;
const POSTER_W = 40;
const POSTER_H = 60;

interface TitleContext {
    title: string;
    posterPath: string | null;
}

export default function ReviewScreen() {
    const params = useLocalSearchParams<{ mediaType: string; tmdbId: string }>();
    const router = useRouter();
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const insets = useSafeAreaInsets();
    // Same pattern as recommend.tsx: bottom-bar paddingBottom flips on
    // keyboard open/close so the Save button doesn't have a 34px
    // home-indicator gap above the keyboard when it rises.
    const keyboard = useKeyboard();

    const mediaType: MediaType | null =
        params.mediaType === 'movie' || params.mediaType === 'tv'
            ? (params.mediaType as MediaType)
            : null;
    const tmdbIdRaw = typeof params.tmdbId === 'string' ? params.tmdbId : '';
    const tmdbId = Number.parseInt(tmdbIdRaw, 10);

    const [titleCtx, setTitleCtx] = useState<TitleContext | null>(null);
    const [body, setBody] = useState('');
    const [visibility, setVisibility] = useState<Visibility>('friends');
    // Defaults to false (most reviews don't contain spoilers). In edit
    // mode it gets seeded from the saved row alongside the body.
    const [containsSpoilers, setContainsSpoilers] = useState(false);
    // Captured at load time so save can detect whether visibility,
    // body, or the spoilers flag actually changed (avoid unnecessary
    // writes) and so the gate disables Save on a pristine review.
    const [initialBody, setInitialBody] = useState('');
    const [initialVisibility, setInitialVisibility] =
        useState<Visibility>('friends');
    const [initialContainsSpoilers, setInitialContainsSpoilers] =
        useState(false);
    const [loading, setLoading] = useState(true);
    const showLoader = useDeferredLoading(loading);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!mediaType || !Number.isFinite(tmdbId)) {
            setError('Invalid title');
            setLoading(false);
            return;
        }
        let active = true;

        const titlePromise: Promise<TitleContext> =
            mediaType === 'movie'
                ? getMovie(tmdbId).then((m: TMDBMovie) => ({
                      title: m.title,
                      posterPath: m.poster_path,
                  }))
                : getTV(tmdbId).then((t: TMDBTV) => ({
                      title: t.name,
                      posterPath: t.poster_path,
                  }));

        (async () => {
            try {
                const [resolvedTitle, sessionResult] = await Promise.all([
                    titlePromise,
                    supabase.auth.getSession(),
                ]);
                if (!active) return;
                setTitleCtx(resolvedTitle);

                const userId = sessionResult.data.session?.user.id;
                if (!userId) throw new Error('Not authenticated');

                // Read items.visibility (the source of truth) AND any
                // existing review body in parallel. Items must exist
                // for the affordance to have been visible on the title
                // screen, but we defend against a race (user toggled
                // off in another window) by treating a missing items
                // row as "default to 'friends', let the upsert /
                // visibility update fail with a clear message if it
                // truly doesn't exist".
                const [itemResult, reviewResult] = await Promise.all([
                    supabase
                        .from('items')
                        .select('visibility')
                        .eq('user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle(),
                    supabase
                        .from('reviews')
                        .select('body, contains_spoilers')
                        .eq('user_id', userId)
                        .eq('tmdb_id', tmdbId)
                        .eq('media_type', mediaType)
                        .maybeSingle(),
                ]);
                if (!active) return;
                if (itemResult.error) throw itemResult.error;
                if (reviewResult.error) throw reviewResult.error;

                const vis: Visibility =
                    itemResult.data?.visibility === 'private'
                        ? 'private'
                        : 'friends';
                setVisibility(vis);
                setInitialVisibility(vis);

                const existingBody = reviewResult.data?.body ?? '';
                setBody(existingBody);
                setInitialBody(existingBody);

                const existingSpoilers =
                    reviewResult.data?.contains_spoilers ?? false;
                setContainsSpoilers(existingSpoilers);
                setInitialContainsSpoilers(existingSpoilers);
            } catch (err) {
                if (!active) return;
                console.error('review load failed:', err);
                setError(err instanceof Error ? err.message : 'Failed to load');
            } finally {
                if (active) setLoading(false);
            }
        })();

        return () => {
            active = false;
        };
    }, [mediaType, tmdbId]);

    const trimmedBody = body.trim();
    // Save gate:
    //   - body must be non-empty (DB CHECK btrim(body) <> '')
    //   - either body or visibility must have changed from the original
    //     (no point in writing a no-op when editing an existing review)
    //   - not currently saving / loading
    const hasChanges =
        trimmedBody !== initialBody.trim()
        || visibility !== initialVisibility
        || containsSpoilers !== initialContainsSpoilers;
    const canSave =
        !saving &&
        !loading &&
        mediaType !== null &&
        trimmedBody.length > 0 &&
        hasChanges;

    async function handleSave() {
        if (!canSave || !mediaType) return;
        setSaving(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const userId = session?.user.id;
            if (!userId) throw new Error('Not authenticated');

            // Upsert the review first. RLS gates this to user_id =
            // auth.uid() per migration 20260607140000.
            const { error: reviewError } = await supabase
                .from('reviews')
                .upsert(
                    {
                        user_id: userId,
                        tmdb_id: tmdbId,
                        media_type: mediaType,
                        body: trimmedBody,
                        contains_spoilers: containsSpoilers,
                    },
                    { onConflict: 'user_id,tmdb_id,media_type' },
                );
            if (reviewError) throw reviewError;

            // Only touch items if the visibility actually changed —
            // saves a write and avoids spurious updated_at bumps on
            // the parent item. Items RLS allows the author to update
            // their own row.
            if (visibility !== initialVisibility) {
                const { error: itemError } = await supabase
                    .from('items')
                    .update({ visibility })
                    .eq('user_id', userId)
                    .eq('tmdb_id', tmdbId)
                    .eq('media_type', mediaType);
                if (itemError) throw itemError;
            }

            // Dismiss immediately on success — the title screen
            // re-fetches on focus return and will surface the saved
            // review and its visibility there.
            router.back();
        } catch (err) {
            console.error('review save failed:', err);
            surfaceError(err, "Couldn't save");
        } finally {
            setSaving(false);
        }
    }

    return (
        <SafeAreaView
            style={[styles.root, { backgroundColor: palette.bg }]}
            edges={['top']}
        >
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    hitSlop={spacing.sm}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                >
                    <Text style={[typography.body, { color: palette.accent }]}>
                        Cancel
                    </Text>
                </Pressable>
                <Text style={[typography.heading, { color: palette.text }]}>
                    Review
                </Text>
                {/* Save lives in the header (top-right, opposite Cancel)
                    rather than the pinned bottom bar — the header never
                    moves with the keyboard, so Save is always reachable
                    while typing. Same canSave gate as before: body must
                    be non-empty AND something changed (body, visibility,
                    or spoilers flag). Spinner replaces the label while
                    the save is in flight. */}
                <Pressable
                    onPress={handleSave}
                    disabled={!canSave}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel="Save review"
                    style={({ pressed }) => [
                        pressed && { opacity: 0.6 },
                        !canSave && { opacity: 0.4 },
                    ]}
                >
                    {saving ? (
                        <ActivityIndicator color={palette.accent} />
                    ) : (
                        <Text
                            style={[
                                typography.bodyEmphasis,
                                { color: palette.accent },
                            ]}
                        >
                            Save
                        </Text>
                    )}
                </Pressable>
            </View>

            {/* No KeyboardAvoidingView — same fix the recommend modal
                uses. KAV's `behavior='padding'` indirection was unreliable
                about lifting the pinned bottom bar above the keyboard
                even though Save in the header is always reachable. The
                bottom bar (visibility toggle + spoilers toggle + char
                counter) was sitting behind the keyboard. We now lift
                the bar directly: on iOS, marginBottom = keyboard.height
                via the existing useKeyboard hook, so the bar's outer
                bottom edge sits exactly at the keyboard's top. Android
                relies on the manifest's windowSoftInputMode="adjustResize"
                — marginBottom: 0 there avoids double-lifting. */}
            <View style={styles.flex}>
                {/* Flex column wrapped in a Pressable so taps on the
                    background (title context, bodyBox border padding,
                    empty area below a short body) dismiss the keyboard.
                    TextInput captures its own touches first; the
                    Pressable only fires for non-touchable areas. No
                    ScrollView: the multi-line TextInput handles
                    internal scrolling itself, and an outer ScrollView
                    fights with KAV when the body field is tall — the
                    bottom bar gets pushed off-screen instead of
                    lifting above the keyboard. With flex:1 on the body
                    box the field shrinks gracefully under the keyboard
                    while the bottom bar stays pinned. */}
                <Pressable
                    onPress={() => Keyboard.dismiss()}
                    style={styles.flex}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    {titleCtx && (
                        <View style={styles.titleContext}>
                            {titleCtx.posterPath ? (
                                <Image
                                    source={{
                                        uri: imageUrl(titleCtx.posterPath, 'w185'),
                                    }}
                                    style={styles.contextPoster}
                                    contentFit="cover"
                                    transition={150}
                                />
                            ) : (
                                <View
                                    style={[
                                        styles.contextPoster,
                                        { backgroundColor: palette.surfaceAlt },
                                    ]}
                                />
                            )}
                            <Text
                                style={[
                                    typography.bodyEmphasis,
                                    styles.contextTitle,
                                    { color: palette.text },
                                ]}
                                numberOfLines={2}
                            >
                                {titleCtx.title}
                            </Text>
                        </View>
                    )}

                    {showLoader ? (
                        <FullScreenLoader />
                    ) : error ? (
                        <View style={styles.statusBlock}>
                            <Text style={[typography.body, { color: palette.error }]}>
                                {error}
                            </Text>
                        </View>
                    ) : (
                        <View
                            style={[
                                styles.bodyBox,
                                styles.flex,
                                {
                                    backgroundColor: palette.surface,
                                    borderColor: palette.border,
                                },
                            ]}
                        >
                            <TextInput
                                value={body}
                                onChangeText={(v) =>
                                    setBody(v.slice(0, REVIEW_MAX_LENGTH))
                                }
                                placeholder="Write your review…"
                                placeholderTextColor={palette.textMuted}
                                multiline
                                maxLength={REVIEW_MAX_LENGTH}
                                editable={!saving}
                                style={[
                                    styles.bodyInput,
                                    styles.flex,
                                    typography.body,
                                    { color: palette.text },
                                ]}
                            />
                        </View>
                    )}
                </Pressable>

                {!loading && !error ? (
                    <View
                        style={[
                            styles.bottomBar,
                            {
                                backgroundColor: palette.bg,
                                borderTopColor: palette.border,
                                paddingBottom: keyboard.open
                                    ? spacing.sm
                                    : insets.bottom + spacing.sm,
                                // iOS-only direct lift via useKeyboard
                                // — matches the recommend modal pattern.
                                // Android relies on adjustResize from
                                // the manifest; lifting here would
                                // double-stack the displacement.
                                marginBottom:
                                    Platform.OS === 'ios' && keyboard.open
                                        ? keyboard.height
                                        : 0,
                            },
                        ]}
                    >
                        {/* Visibility toggle — must default to the item's
                            current value and make the current state
                            visibly obvious before save. Two pills,
                            accent fill for the active one, matching the
                            inbox Received/Sent toggle pattern. */}
                        <Text
                            style={[
                                typography.micro,
                                styles.bottomBarLabel,
                                { color: palette.textMuted },
                            ]}
                        >
                            WHO CAN SEE THIS
                        </Text>
                        <View style={styles.visibilityRow}>
                            {(['friends', 'private'] as const).map((v) => {
                                const active = visibility === v;
                                return (
                                    <Pressable
                                        key={v}
                                        onPress={() => setVisibility(v)}
                                        disabled={saving}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: active }}
                                        style={({ pressed }) => [
                                            styles.visibilityButton,
                                            {
                                                backgroundColor: active
                                                    ? palette.accent
                                                    : 'transparent',
                                                borderColor: active
                                                    ? palette.accent
                                                    : palette.border,
                                                opacity: pressed ? 0.6 : 1,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                typography.bodyEmphasis,
                                                {
                                                    color: active
                                                        ? palette.textInverse
                                                        : palette.textMuted,
                                                },
                                            ]}
                                        >
                                            {v === 'friends'
                                                ? 'Friends can see this'
                                                : 'Private'}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                        {/* Spoilers toggle — compact single on/off
                            (Switch) rather than a segmented control,
                            since this is a binary property and the
                            visibility toggle above already uses the
                            two-pill segmented treatment. Persists via
                            contains_spoilers on the reviews row. */}
                        <View style={styles.spoilerRow}>
                            <Text
                                style={[
                                    typography.body,
                                    { color: palette.text },
                                ]}
                            >
                                Contains spoilers
                            </Text>
                            <Switch
                                value={containsSpoilers}
                                onValueChange={setContainsSpoilers}
                                disabled={saving}
                                trackColor={{
                                    false: palette.surfaceAlt,
                                    true: palette.accent,
                                }}
                            />
                        </View>
                        <Text
                            style={[
                                typography.caption,
                                styles.charCount,
                                { color: palette.textMuted },
                            ]}
                        >
                            {body.length}/{REVIEW_MAX_LENGTH}
                        </Text>
                    </View>
                ) : null}
            </View>
        </SafeAreaView>
    );
}

function surfaceError(err: unknown, title: string) {
    if (err && typeof err === 'object' && 'message' in err) {
        const supaErr = err as {
            message: string;
            details?: string;
            hint?: string;
            code?: string;
        };
        Alert.alert(
            title,
            `${supaErr.message}${supaErr.hint ? '\n\n' + supaErr.hint : ''}`,
        );
    } else {
        Alert.alert(title, String(err));
    }
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.base,
        paddingBottom: spacing.sm,
    },
    titleContext: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
    },
    contextPoster: {
        width: POSTER_W,
        height: POSTER_H,
        borderRadius: radius.sm,
    },
    contextTitle: {
        flex: 1,
    },
    statusBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xxl,
        paddingHorizontal: spacing.xl,
    },
    bodyBox: {
        marginHorizontal: spacing.lg,
        marginBottom: spacing.md,
        borderRadius: radius.sm,
        borderWidth: 1,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        // No minHeight — the inline flex:1 in render lets the box fill
        // available space when the keyboard is closed and shrink when
        // it rises, so the bottom bar always stays above the keyboard.
        // TextInput multiline scrolls internally for long content, so
        // we don't need an outer ScrollView fighting for height.
    },
    bodyInput: {
        // Matches the recommend modal's noteInput maxHeight pattern.
        // Bodyflex:1 already caps growth at the available space when
        // the keyboard is open, but the explicit maxHeight is a
        // safety net so a very long review scrolls internally instead
        // of having any chance to fight the bottom-bar's layout. Sized
        // generously so the body still feels like the primary surface
        // when there's room.
        maxHeight: 400,
        textAlignVertical: 'top',
    },
    bottomBar: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    bottomBarLabel: {
        marginBottom: spacing.sm,
        letterSpacing: 0.5,
    },
    visibilityRow: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    visibilityButton: {
        flex: 1,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    spoilerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: spacing.md,
    },
    charCount: {
        textAlign: 'right',
        marginTop: spacing.xs,
    },
});
