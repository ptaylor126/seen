import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Pencil } from 'lucide-react-native';
import { Fragment, useCallback, useState } from 'react';
import {
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import { ScreenHeader } from '@/components/screen-header';
import { TopFiveSections } from '@/components/top-five-sections';
import { useProfile } from '@/hooks/use-profile';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { signOut } from '@/lib/auth';
import { fetchFavoritesForUser, type UserFavorites } from '@/lib/favorites';
import {
    button,
    getPalette,
    ICON_STROKE_WIDTH,
    radius,
    spacing,
    typography,
} from '@/theme/theme';

const AVATAR_SIZE = 96;

export default function ProfileScreen() {
    const scheme = useColorScheme() ?? 'light';
    const palette = getPalette(scheme);
    const router = useRouter();
    const tabBarInset = useFloatingTabBarInset();
    const { count: unreadCount } = useUnreadCount();
    // Read from the shared profile context so /profile/edit's
    // refresh() call propagates here automatically. Previously this
    // screen kept its own local state with a once-on-mount fetch,
    // which meant edits never showed because the tab stays mounted
    // and the effect never re-fired.
    const { status, profile } = useProfile();
    const showLoader = useDeferredLoading(status === 'loading');
    const [favorites, setFavorites] = useState<UserFavorites>({
        movies: [],
        tv: [],
    });

    // Re-fetch on focus so the section refreshes when the editor (Layer 3)
    // ships and the user returns from it. Today it just loads once per
    // tab focus — the favorites table can't change without an editor.
    // Failures are silent: a transient read error degrades to "no top 5
    // shown," not a broken profile screen.
    useFocusEffect(
        useCallback(() => {
            const userId = profile?.id;
            if (!userId) return;
            let active = true;
            (async () => {
                try {
                    const result = await fetchFavoritesForUser(userId);
                    if (active) setFavorites(result);
                } catch (err) {
                    console.warn('own favorites fetch failed:', err);
                }
            })();
            return () => {
                active = false;
            };
        }, [profile?.id]),
    );

    async function handleSignOut() {
        try {
            await signOut();
            // useSession's onAuthStateChange subscription flips to ready/null,
            // root layout's useEffect redirects to /(auth)/sign-in.
        } catch (err) {
            console.error('sign out failed:', err);
            Alert.alert(
                'Sign out failed',
                err instanceof Error ? err.message : 'Unknown error',
            );
        }
    }

    function confirmSignOut() {
        Alert.alert('Sign out of Seen?', undefined, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign out', style: 'destructive', onPress: handleSignOut },
        ]);
    }

    // Nav rows only. "Edit profile" moved to the avatar pencil badge;
    // "Sign out" is rendered separately below as a visually-distinct
    // exit action (not a neutral nav row).
    const rows: Array<{ id: string; label: string; onPress: () => void }> = [
        {
            id: 'favorites',
            label: 'Edit Top 5',
            onPress: () => router.push('/profile/favorites'),
        },
        {
            id: 'feedback',
            label: 'Send feedback',
            // In-app feedback screen (submits to the submit-feedback Edge
            // Function). Replaced the previous mailto: composer.
            onPress: () => router.push('/profile/feedback'),
        },
        {
            id: 'account',
            label: 'Account',
            onPress: () => router.push('/profile/account'),
        },
    ];

    if (showLoader) {
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader title="Profile" unreadCount={unreadCount} />
                <FullScreenLoader />
            </View>
        );
    }

    if (!profile) {
        // useProfile retries on transient errors internally, so a null
        // profile after status=ready is a genuine miss (e.g. trigger
        // never created a row). Same fallback copy as before.
        return (
            <View style={[styles.root, { backgroundColor: palette.bg }]}>
                <ScreenHeader title="Profile" unreadCount={unreadCount} />
                <View style={styles.fillCenter}>
                    <Text style={[typography.body, { color: palette.error }]}>
                        Profile not available
                    </Text>
                </View>
            </View>
        );
    }

    const firstLetter = profile.displayName[0]?.toUpperCase() ?? '?';

    return (
        <View style={[styles.root, { backgroundColor: palette.bg }]}>
            <ScreenHeader title="Profile" unreadCount={unreadCount} />
            {/* Scroll wrapper: the screen was previously flat (card + settings
                rows) and fit comfortably on a phone. Adding the top-5
                sections can push content past the viewport on small devices
                and once the editor lands the section can grow further, so
                everything below the header is scrollable now. Pure layout
                change — no visual difference when content fits on screen. */}
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    // tabBarInset clears the floating nav exactly (bar
                    // height + gap + safe-area) — fine for a list whose
                    // last row tucks just above the bar, but the solo
                    // Sign out button at the very bottom reads as jammed
                    // against it. + spacing.xl gives a comfortable gap
                    // below the button before the nav.
                    { paddingBottom: tabBarInset + spacing.xl },
                ]}
            >
                <View style={styles.card}>
                    <View style={styles.avatarWrapper}>
                        {profile.avatarUrl ? (
                            <Image
                                source={{ uri: profile.avatarUrl }}
                                style={[styles.avatar, { backgroundColor: palette.accent }]}
                                contentFit="cover"
                                transition={200}
                            />
                        ) : (
                            <View
                                style={[
                                    styles.avatar,
                                    styles.avatarFallback,
                                    { backgroundColor: palette.accent },
                                ]}
                            >
                                <Text style={[typography.display, { color: palette.textInverse }]}>
                                    {firstLetter}
                                </Text>
                            </View>
                        )}
                        {/* Edit badge — bottom-right of the avatar, the
                            standard profile-edit affordance. Replaces the
                            removed "Edit profile" list row; routes to the
                            same /profile/edit screen. palette.bg ring so
                            the plum badge separates from the avatar. */}
                        <Pressable
                            onPress={() => router.push('/profile/edit')}
                            accessibilityRole="button"
                            accessibilityLabel="Edit profile"
                            hitSlop={spacing.sm}
                            style={({ pressed }) => [
                                styles.editBadge,
                                {
                                    backgroundColor: palette.accent,
                                    borderColor: palette.bg,
                                },
                                pressed && { opacity: 0.6 },
                            ]}
                        >
                            <Pencil
                                color={palette.textInverse}
                                size={16}
                                strokeWidth={ICON_STROKE_WIDTH}
                            />
                        </Pressable>
                    </View>
                    {/* Name + handle grouped tight so they read as one
                        unit (the card's old uniform gap spread them out). */}
                    <View style={styles.nameBlock}>
                        <Text style={[typography.display, { color: palette.text }]}>
                            {profile.displayName}
                        </Text>
                        <Text style={[typography.body, { color: palette.textMuted }]}>
                            @{profile.handle}
                        </Text>
                    </View>
                </View>

                {/* Top 5 sections — render nothing when both lists are
                    empty. Layer 3 (the editor) will add a "Tap to add"
                    affordance on the owner's profile; for now the
                    absence of content is the only signal that no
                    favorites have been picked yet. The wrapper is
                    conditional so the marginBottom doesn't fire on
                    the empty case. */}
                {(favorites.movies.length > 0 || favorites.tv.length > 0) && (
                    <View style={styles.topFiveBlock}>
                        <TopFiveSections
                            movies={favorites.movies}
                            tv={favorites.tv}
                            palette={palette}
                            onSelect={(mediaType, tmdbId) =>
                                router.push({
                                    pathname: '/title/[mediaType]/[tmdbId]',
                                    params: {
                                        mediaType,
                                        tmdbId: String(tmdbId),
                                    },
                                })
                            }
                        />
                    </View>
                )}

                <View>
                    {rows.map((row, i) => (
                        <Fragment key={row.id}>
                            {i > 0 && (
                                <View
                                    style={[styles.separator, { backgroundColor: palette.border }]}
                                />
                            )}
                            <Pressable
                                onPress={row.onPress}
                                style={({ pressed }) => [
                                    styles.settingsRow,
                                    pressed && { opacity: 0.6 },
                                ]}
                            >
                                <Text
                                    style={[
                                        typography.body,
                                        styles.settingsLabel,
                                        { color: palette.text },
                                    ]}
                                >
                                    {row.label}
                                </Text>
                                <ChevronRight
                                    color={palette.textMuted}
                                    size={20}
                                    strokeWidth={ICON_STROKE_WIDTH}
                                />
                            </Pressable>
                        </Fragment>
                    ))}
                </View>

                {/* Sign out — a subtle OUTLINED button (1px border,
                    transparent fill), separated from the neutral nav
                    rows by a gap so it reads as a deliberate exit
                    action rather than another setting. Not red:
                    sign out is reversible; the confirm dialog carries
                    the emphasis. */}
                <Pressable
                    onPress={confirmSignOut}
                    accessibilityRole="button"
                    accessibilityLabel="Sign out"
                    style={({ pressed }) => [
                        styles.signOutButton,
                        { borderColor: palette.border },
                        pressed && { opacity: 0.6 },
                    ]}
                >
                    <Text style={[typography.body, { color: palette.text }]}>
                        Sign out
                    </Text>
                </Pressable>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    fillCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    scrollContent: {
        // paddingBottom set inline at the ScrollView via
        // useFloatingTabBarInset — the floating nav provides the
        // trailing breath that the previous static spacing.xl
        // covered for the old non-floating tab bar.
    },
    topFiveBlock: {
        // Vertical breathing room between the profile card and the
        // settings list. When the component returns null (no favorites
        // either side) this still adds spacing but it's negligible and
        // saves a conditional wrapper.
        paddingBottom: spacing.lg,
    },
    card: {
        // No uniform `gap` — the avatar→name and name↔handle gaps are
        // set explicitly (nameBlock.marginTop / nameBlock natural line
        // spacing) so the name + handle can sit tight as one unit.
        alignItems: 'center',
        paddingTop: spacing.xl,
        paddingBottom: spacing.xl,
        paddingHorizontal: spacing.base,
    },
    avatarWrapper: {
        // Relative box sized to the avatar so the edit badge can anchor
        // to its bottom-right corner.
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        position: 'relative',
    },
    avatar: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
    },
    avatarFallback: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    editBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 30,
        height: 30,
        borderRadius: 15,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    nameBlock: {
        // Gap from the avatar; name + handle inside stack at natural
        // line spacing (no extra gap) so they read as one unit.
        alignItems: 'center',
        marginTop: spacing.md,
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.base,
        paddingVertical: spacing.base,
    },
    settingsLabel: { flex: 1 },
    separator: {
        height: StyleSheet.hairlineWidth,
        marginLeft: spacing.base,
    },
    signOutButton: {
        // Subtle outlined button: 1px border (color set inline via
        // palette.border), transparent fill, centered label. Full-width
        // within the screen margins. marginTop separates the exit from
        // the nav list above; radius.sm matches the app's button shape.
        marginTop: spacing.lg,
        marginHorizontal: spacing.base,
        paddingVertical: button.paddingVertical,
        borderWidth: 1,
        borderRadius: button.borderRadius,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
