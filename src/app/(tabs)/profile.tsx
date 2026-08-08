import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import {
    CaretRight,
    PencilSimple,
} from 'phosphor-react-native';
import { Fragment, useCallback, useState } from 'react';
import {
    Alert,
    Pressable,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from 'react-native';

import { FullScreenLoader, useDeferredLoading } from '@/components/full-screen-loader';
import { useFloatingTabBarInset } from '@/components/floating-tab-bar';
import { ArchCap, ARCH_DEPTH } from '@/components/profile-arch';
import { ScreenHeader } from '@/components/screen-header';
import { TopFiveSections } from '@/components/top-five-sections';
import { useProfile } from '@/hooks/use-profile';
import { useUnreadCount } from '@/hooks/use-unread-count';
import { signOut } from '@/lib/auth';
import { LIBRARY_IMPORT_ENABLED } from '@/lib/feature-flags';
import { fetchFavoritesForUser, type UserFavorites } from '@/lib/favorites';
import {
    button,
    getPalette,
    radius,
    spacing,
    STATUS_BAR_STYLE,
    typography,
} from '@/theme/theme';

const AVATAR_SIZE = 96;
// Plum banner zone inside the scroll content: from below the fixed header
// row down to the arch crest (measured off the profile mockup). The plum
// additionally fills the whole fixed-chrome area above via the onAccent
// ScreenHeader, so it reaches the physical top of the screen.
const BANNER_ZONE = 74;
// Avatar straddles the arch crest — its centre sits a hair ABOVE the crest
// (the mockup's placement: centre 189pt vs crest 193pt on a 393pt frame),
// half over plum, half over the sheet.
const AVATAR_TOP = BANNER_ZONE - AVATAR_SIZE / 2 - 4;

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

    // Light status-bar content while the plum banner is on screen (the
    // banner reaches the physical top, behind the clock/battery), restored
    // to dark on blur so light-background screens (inbox, library, a pushed
    // title page) never end up with invisible status-bar icons. Gated on
    // `profile` — the loading/error branches render the standard bg header.
    useFocusEffect(
        useCallback(() => {
            if (!profile) return;
            StatusBar.setBarStyle('light-content');
            return () => StatusBar.setBarStyle(STATUS_BAR_STYLE);
        }, [profile]),
    );

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
        // Library import (stage 2) — hidden until the OTA that flips
        // LIBRARY_IMPORT_ENABLED. Spread-conditional so the flag leaves
        // no dead row behind.
        ...(LIBRARY_IMPORT_ENABLED
            ? [
                  {
                      id: 'import',
                      label: 'Import your library',
                      onPress: () => router.push('/profile/import'),
                  },
              ]
            : []),
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
            {/* Plum header chrome — the banner fills the fixed top area
                (safe area + header row) via onAccent and continues into the
                scroll content below, so the plum reaches the physical top
                edge of the screen behind the status bar. */}
            <ScreenHeader title="Profile" unreadCount={unreadCount} onAccent />
            {/* Scroll wrapper: the screen was previously flat (card + settings
                rows) and fit comfortably on a phone. Adding the top-5
                sections can push content past the viewport on small devices
                and once the editor lands the section can grow further, so
                everything below the header is scrollable now. */}
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
                {/* Top-bounce cap: extends the plum above the content so an
                    iOS overscroll at the top shows plum, never a bg seam. */}
                <View
                    style={[styles.bounceCap, { backgroundColor: palette.accent }]}
                />
                {/* Plum banner zone (scrolls with content), then the arched
                    top of the sheet. The avatar straddles the crest via the
                    absolute cluster below. */}
                <View
                    style={[
                        styles.bannerZone,
                        { backgroundColor: palette.accent },
                    ]}
                />
                <ArchCap />
                {/* Name + handle on the sheet, clear of the arch curve. */}
                <View style={styles.nameBlock}>
                    <Text style={[typography.display, { color: palette.text }]}>
                        {profile.displayName}
                    </Text>
                    <Text style={[typography.body, { color: palette.textMuted }]}>
                        @{profile.handle}
                    </Text>
                </View>
                {/* Avatar cluster — absolute over the banner/sheet boundary,
                    half on the plum, half on the arch. Keeps the edit
                    pencil badge. */}
                <View style={styles.archAvatar} pointerEvents="box-none">
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
                            standard profile-edit affordance. The badge sits
                            on the sheet side of the straddle, so the
                            palette.bg ring still separates it correctly. */}
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
                            <PencilSimple
                                color={palette.textInverse}
                                size={16}
                            />
                        </Pressable>
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
                                <CaretRight
                                    color={palette.textMuted}
                                    size={20}
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
    // Top-bounce cap: plum extended 600pt above the scroll content so an
    // iOS overscroll never exposes a bg seam above the banner.
    bounceCap: {
        position: 'absolute',
        top: -600,
        left: 0,
        right: 0,
        height: 600,
    },
    // Plum banner zone inside the scroll content — from below the fixed
    // header row to the arch crest.
    bannerZone: {
        width: '100%',
        height: BANNER_ZONE,
    },
    // Avatar cluster straddling the banner/sheet boundary. box-none so the
    // full-width wrapper doesn't eat taps beside the avatar.
    archAvatar: {
        position: 'absolute',
        top: AVATAR_TOP,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 2,
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
        borderRadius: radius.full,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    nameBlock: {
        // On the sheet, below the straddling avatar: md (was lg) pulls the
        // name up closer under the image — ~21pt from the avatar's bottom
        // edge, accounting for the avatar's descent past the arch cap. Name
        // + handle stack at natural line spacing so they read as one unit.
        // paddingBottom is the old card's gap before the Top 5 sections.
        alignItems: 'center',
        marginTop: spacing.md,
        paddingBottom: spacing.xl,
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
