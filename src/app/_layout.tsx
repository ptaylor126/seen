import {
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    useFonts,
} from '@expo-google-fonts/geist';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LaunchSequence } from '@/components/launch-sequence';
import { LaunchReadyContext } from '@/hooks/use-launch-ready';
import { ProfileProvider, useProfile } from '@/hooks/use-profile';
import { usePushNavigation } from '@/hooks/use-push-navigation';
import { useSession } from '@/hooks/use-session';

// Pin the root navigator's initial/anchor route to (tabs). With three root
// groups — (auth), (onboarding), (tabs) — and no app/index.tsx, expo-router
// has no deterministic base and falls back to mounting a group screen
// ((onboarding)/welcome) as the initial route on cold launch. That base stays
// visible for the whole session+profile-resolve window (~1s) until the routing
// effect replaces it — i.e. an already-onboarded user briefly sees onboarding.
// Anchoring to (tabs) makes home the base for everyone; signed-out /
// not-onboarded users are then replaced OUT to (auth)/(onboarding) by the
// routing effect, so onboarding never mounts for an onboarded user.
export const unstable_settings = { anchor: '(tabs)' };

// Keep the native splash up through font load — without this the splash
// hides as soon as the first React frame mounts (even a `null` render),
// flashing the cream background before Geist is ready.
SplashScreen.preventAutoHideAsync().catch(() => {
    // Already-prevented or called twice during fast refresh — safe to ignore.
});

export default function RootLayout() {
    // Load Geist before the rest of the tree mounts. Until the fonts
    // are resolved, typography.body etc. would render in the system
    // font, then flash to Geist mid-launch — holding the tree
    // suppresses the flash. expo-font is a JS-side module, so this
    // works without an EAS rebuild.
    const [fontsLoaded] = useFonts({
        Geist_400Regular,
        Geist_500Medium,
        Geist_600SemiBold,
        Geist_700Bold,
    });

    useEffect(() => {
        if (fontsLoaded) {
            SplashScreen.hideAsync().catch(() => {
                // Splash may already be hidden; ignore.
            });
        }
    }, [fontsLoaded]);

    if (!fontsLoaded) return null;

    // ProfileProvider sits above RootLayoutInner so useProfile() inside
    // the routing effect reads from the same context the onboarding
    // screens write to via refresh(). Without the shared context, the
    // post-onboarding navigation would race against a stale profile
    // state and bounce the user back into the flow.
    //
    // GestureHandlerRootView is the OUTERMOST wrapper because
    // react-native-gesture-handler strictly requires it as an ancestor
    // of any component that uses its gestures (NativeViewGestureHandler,
    // long-press / pan / pinch handlers, etc.). Stack-navigator's
    // back-swipe gestures worked without it because iOS gesture-handler
    // can find a root view through fallback paths, but
    // NestableDraggableFlatList in the Top 5 editor (and any future
    // drag / swipe surface we add) exercises the strict path and
    // throws "NativeViewGestureHandler must be used as a descendant
    // of GestureHandlerRootView" without this wrapper. style={{ flex: 1 }}
    // is mandatory — without it the view collapses to zero height
    // and the whole app renders blank. NOTE: React Native <Modal>
    // components render OUTSIDE this tree on iOS (separate native
    // view controller — same reason SafeAreaView doesn't work inside
    // Modal); any draggable list rendered inside a Modal would need
    // its own GestureHandlerRootView inside the Modal.
    // KeyboardProvider (react-native-keyboard-controller) sits between the
    // infra providers and the domain providers: inside GestureHandlerRootView
    // (which must stay OUTERMOST per gesture-handler's strict requirement)
    // and SafeAreaProvider, but outside ProfileProvider and the entire
    // navigation tree, so every screen — including modally-presented routes —
    // renders under it. It enables the library's native keyboard module;
    // by itself it changes no behavior (screens opt in via the library's
    // KeyboardAvoidingView / KeyboardStickyView / hooks in the migration
    // commits that follow).
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <KeyboardProvider>
                    <ProfileProvider>
                        <RootLayoutInner />
                    </ProfileProvider>
                </KeyboardProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}

function RootLayoutInner() {
    const session = useSession();
    const profile = useProfile();
    const segments = useSegments();
    const router = useRouter();

    // Drive routing once both the session AND the profile have resolved.
    // Three terminal states:
    //   - signed out → /(auth)/sign-in
    //   - signed in + !onboarded → /(onboarding)/welcome
    //   - signed in +  onboarded → /(tabs)
    useEffect(() => {
        if (session.status !== 'ready') return;

        const inAuthGroup = segments[0] === '(auth)';
        const inOnboardingGroup = segments[0] === '(onboarding)';

        if (!session.session) {
            if (!inAuthGroup) router.replace('/(auth)/sign-in');
            return;
        }

        // Wait for profile too. BOTH conditions are required:
        //   1. status === 'ready', AND
        //   2. a RESOLVED profile row exists (profile.profile != null).
        // status alone is insufficient: refresh() never flips status back to
        // 'loading' when a new refresh starts, so a prior refresh can leave
        // status==='ready' with a null/stale profile (e.g. a cold-start
        // getSession() that briefly saw no session set ready+null) while a NEW
        // refresh is still in flight. Reading onboarded then coerces the null
        // profile to false (?? false) and misroutes an onboarded user into
        // onboarding. Gating on profile.profile means onboarded is only ever
        // read from the real resolved row. A genuinely new user has a row with
        // onboarded=false (created by the signup trigger), so they still reach
        // onboarding.
        if (profile.status !== 'ready' || !profile.profile) return;

        const onboarded = profile.profile.onboarded;
        if (!onboarded) {
            if (!inOnboardingGroup) router.replace('/(onboarding)/welcome');
            return;
        }
        // Onboarded: pull the user out of (auth) or (onboarding) into
        // the main app. No-op if they're already in (tabs) or any
        // pushed modal route.
        if (inAuthGroup || inOnboardingGroup) {
            router.replace('/(tabs)');
        }
    }, [session, profile, segments, router]);

    // Launch readiness — the launch sequence stays up until the real
    // destination is ready (not a timer). Signed-out → just session resolved;
    // not-onboarded → session + profile; onboarded → also HOME's first data
    // load, reported via markDestinationReady (settles on success OR error).
    const [homeReady, setHomeReady] = useState(false);
    const markDestinationReady = useCallback(() => setHomeReady(true), []);

    // Gate dismissal on the resolved destination route being ACTIVE — not just
    // the data — so the overlay covers the routing transition. Otherwise an
    // already-onboarded user briefly sees the default/onboarding screen (the
    // pre-routing initial route) before the replace-to-(tabs) lands. Onboarded
    // also waits for home's first data load (homeReady).
    const inAuthGroup = segments[0] === '(auth)';
    const inOnboardingGroup = segments[0] === '(onboarding)';
    const inTabsGroup = segments[0] === '(tabs)';

    const ready =
        session.status === 'ready' &&
        (!session.session
            ? inAuthGroup
            : profile.status === 'ready' &&
              ((profile.profile?.onboarded ?? false)
                  ? inTabsGroup && homeReady
                  : inOnboardingGroup));

    // One-time gate: the animated launch overlay shows on cold start and
    // dismisses once (ready + intro done, or the safety timeout). It does not
    // return for later in-app transitions.
    const [launchActive, setLaunchActive] = useState(true);

    // Deep-link a tapped push notification to the relevant screen. launchDone
    // gates cold-start navigation until the launch overlay has dismissed (see
    // the hook — navigating earlier wedges the launch-`ready` condition).
    usePushNavigation({ session, profile, launchDone: !launchActive });

    return (
        <LaunchReadyContext.Provider value={{ markDestinationReady }}>
            <Stack screenOptions={{ headerShown: false }}>
                {/* fullScreenModal (not 'modal'): the title page is reached
                    both standalone AND stacked over the rec view (itself a
                    modal). A nested 'modal' renders as a reduced card sheet
                    that clips the title's lower sections; fullScreenModal
                    always covers the screen, so "View details" from a rec
                    opens the FULL page and back returns to the rec. Trade:
                    no swipe-to-dismiss anywhere — the in-page X (CloseButton)
                    is the dismiss affordance on every entry point. */}
                <Stack.Screen
                    name="title/[mediaType]/[tmdbId]"
                    options={{ presentation: 'fullScreenModal' }}
                />
                <Stack.Screen
                    name="title/[mediaType]/[tmdbId]/recommend"
                    options={{ presentation: 'modal' }}
                />
                <Stack.Screen
                    name="title/[mediaType]/[tmdbId]/review"
                    options={{ presentation: 'modal' }}
                />
                <Stack.Screen
                    name="library/add"
                    options={{ presentation: 'modal' }}
                />
                <Stack.Screen
                    name="person/[personId]"
                    options={{ presentation: 'modal' }}
                />
                {/* Card (push), NOT modal: the rec view drills into the
                    title page via "View details". When the rec was a modal,
                    pushing the title stacked a second modal in the same
                    native stack, which iOS clips to a nested card sheet
                    (rounded edge, lower sections cut off) even with
                    fullScreenModal. As a card, rec → title is structurally
                    identical to inbox → title (modal opened from a normal
                    screen) → the title presents as a first-level
                    fullScreenModal: genuinely full-screen, all sections,
                    and back returns to the rec. */}
                <Stack.Screen
                    name="rec/[recId]"
                    options={{ presentation: 'card' }}
                />
            </Stack>
            {launchActive && (
                <LaunchSequence
                    ready={ready}
                    onDone={() => setLaunchActive(false)}
                />
            )}
        </LaunchReadyContext.Provider>
    );
}
