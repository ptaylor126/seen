// Expo push-token registration helpers.
//
// Permission flow is split deliberately: registerForPushNotifications()
// never prompts — it only returns a token if permission has *already*
// been granted (or null if not). Callers (e.g. the friend-accept flow)
// decide when to call requestPushPermission() to trigger the system
// prompt, so the prompt only fires after a "social commitment" moment
// where notifications are obviously relevant.

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Alert, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import supabase from '@/lib/supabase';

// Per-install device id persisted in AsyncStorage. Uninstall + reinstall
// generates a new one — that's fine because the send-push-notification
// Edge Function dedupes by expo_push_token value at send time (one
// banner per physical device regardless of how many push_tokens rows
// have accumulated for it; see that function's comment on the dedup
// step). The DeviceNotRegistered reap path in the same function is for
// GENUINE token invalidation (app uninstalled, never reinstalled); it
// does NOT fire when Expo reissues the same token for the same device
// after reinstall — Expo keeps the old token "valid" in that case, so
// rows accumulate indefinitely without the send-time dedup. If anyone
// later considers removing that dedup, understand that the reap alone
// won't keep duplicates out for the common iOS reinstall path. This
// approach avoids the privacy / cross-platform headaches of
// expo-device's hardware IDs.
const DEVICE_ID_KEY = 'seen.push.device_id';

// One-time gate for the "notifications are off" nudge shown at a high-intent
// moment when permission is already denied (iOS won't re-show the system
// dialog once denied). Persisted so we point the user to Settings exactly
// once, never repeatedly — the nudge must not nag.
const DENIED_NUDGE_KEY = 'seen.push.denied_nudge_shown';

async function getOrCreateDeviceId(): Promise<string> {
    const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    // RN's crypto.randomUUID is available on Hermes; the polyfill from
    // react-native-url-polyfill (already imported in supabase.ts) covers
    // the URL globals but not crypto. Fall back to a simple random hex
    // string if randomUUID is missing — uniqueness across one user's
    // devices is enough; collision risk across the whole app is
    // astronomically low.
    const fresh =
        typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : Array.from({ length: 32 }, () =>
                  Math.floor(Math.random() * 16).toString(16),
              ).join('');
    await AsyncStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
}

function getProjectId(): string | null {
    // Constants.expoConfig.extra.eas.projectId is the runtime-visible
    // EAS project id (set in app.json under extra.eas.projectId, which
    // EAS Build also reads). Required by getExpoPushTokenAsync.
    const fromExpoConfig = Constants.expoConfig?.extra?.eas?.projectId;
    const fromEasConfig = Constants.easConfig?.projectId;
    return (fromExpoConfig ?? fromEasConfig ?? null) as string | null;
}

// If permission is already granted, returns the Expo push token. If
// permission is undetermined or denied, returns null without
// prompting. The permission prompt is gated through requestPushPermission().
export async function registerForPushNotifications(): Promise<string | null> {
    const settings = await Notifications.getPermissionsAsync();
    if (settings.status !== 'granted') return null;

    const projectId = getProjectId();
    if (!projectId) {
        console.warn('push: no EAS projectId — cannot get Expo push token');
        return null;
    }

    try {
        const result = await Notifications.getExpoPushTokenAsync({ projectId });
        return result.data;
    } catch (err) {
        console.warn('push: getExpoPushTokenAsync failed', err);
        return null;
    }
}

// Triggers the iOS / Android system permission prompt. Returns true if
// the user granted. Caller should already have shown an in-app
// explainer before calling this — the system prompt itself is yes/no
// with no second chance once the user picks Don't Allow.
export async function requestPushPermission(): Promise<boolean> {
    const result = await Notifications.requestPermissionsAsync({
        ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true,
        },
    });
    return result.status === 'granted';
}

// Upsert the Expo push token for the current user + device. Schema's
// unique constraint is (user_id, device_id) — see TECHNICAL.md
// push_tokens — so re-running with the same device_id is idempotent,
// rotating the token in place. last_seen_at is bumped on every call
// so the cleanup cron can reap rows whose last touch is stale.
export async function savePushToken(token: string, userId: string): Promise<void> {
    const deviceId = await getOrCreateDeviceId();
    const platform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';

    const { error } = await supabase.from('push_tokens').upsert(
        {
            user_id: userId,
            expo_push_token: token,
            platform,
            device_id: deviceId,
            last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,device_id' },
    );
    if (error) throw error;
}

function askPushExplainer(): Promise<boolean> {
    return new Promise((resolve) => {
        Alert.alert(
            'Turn on notifications?',
            'Turn on notifications so you know when friends send you recommendations, or watch something you recommended to them.',
            [
                {
                    text: 'Not now',
                    style: 'cancel',
                    onPress: () => resolve(false),
                },
                { text: 'Continue', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
}

// Higher-level entry point called after a "social commitment" moment
// (currently friend-accept). Walks the user through the explainer +
// system prompt if they haven't decided, then registers + saves their
// token. Silent on every failure branch — push isn't critical to the
// caller's flow.
export async function maybeEnablePushAfterAccept(userId: string): Promise<void> {
    try {
        const settings = await Notifications.getPermissionsAsync();
        let granted = settings.status === 'granted';

        if (settings.status === 'undetermined') {
            const userConfirmed = await askPushExplainer();
            if (!userConfirmed) return;
            granted = await requestPushPermission();
        }

        if (!granted) return;

        const token = await registerForPushNotifications();
        if (token) await savePushToken(token, userId);
    } catch (err) {
        console.warn('push: enable-after-accept failed silently', err);
    }
}

// Gentle, once-ever nudge for the DENIED case. iOS won't re-show the system
// dialog after a denial, so at a high-intent moment we point the user to
// Settings instead — but only the first time, so it never nags. Persisted in
// AsyncStorage; silent on any failure (push isn't critical to the caller).
async function showPushDeniedNudgeOnce(): Promise<void> {
    try {
        const shown = await AsyncStorage.getItem(DENIED_NUDGE_KEY);
        if (shown) return;
        await AsyncStorage.setItem(DENIED_NUDGE_KEY, '1');
        Alert.alert(
            'Notifications are off',
            'Turn on notifications in Settings to hear when friends recommend you things.',
            [
                { text: 'Not now', style: 'cancel' },
                {
                    text: 'Open Settings',
                    onPress: () => {
                        void Linking.openSettings();
                    },
                },
            ],
            { cancelable: true },
        );
    } catch (err) {
        console.warn('push: denied-nudge failed silently', err);
    }
}

// High-intent entry point — call after a deliberate social moment (sending a
// rec, accepting a friend). GRANTED → silently refresh + save the token;
// UNDETERMINED → soft explainer + system prompt (via maybeEnablePushAfterAccept);
// DENIED → the once-ever Settings nudge above. Silent on failure.
export async function promptPushAtHighIntent(userId: string): Promise<void> {
    try {
        const settings = await Notifications.getPermissionsAsync();
        if (settings.status === 'denied') {
            await showPushDeniedNudgeOnce();
            return;
        }
        await maybeEnablePushAfterAccept(userId);
    } catch (err) {
        console.warn('push: high-intent prompt failed silently', err);
    } finally {
        // Re-assert the true count after the permission flow settles — on
        // EVERY branch (granted / denied / prompt-shown / error). iOS zeroes
        // the app-icon badge when badge authorisation is newly granted, and
        // IconBadgeSync only writes on a count *change*, so an unchanged
        // count leaves the icon stranded at 0. This re-asserts the real
        // number. push.ts can't read the (tabs)-scoped UnreadCountProvider,
        // so it fetches the same value from the same RPC (see helper).
        await reassertBadgeFromServer();
    }
}

// Fetch the current unread count from the server and write it to the OS
// app-icon badge. GUARDED against the known trap: if there is no signed-in
// user, or the RPC errors / returns a non-number, it writes NOTHING — never a
// spurious 0. Uses the exact same invocation the bell provider uses
// (unread_count, param p_uid), so the value can't diverge from the bell.
async function reassertBadgeFromServer(): Promise<void> {
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (!userId) return; // no real count to assert → leave the badge alone

        const { data, error } = await supabase.rpc('unread_count', {
            p_uid: userId,
        });
        if (error) throw error;
        if (typeof data === 'number') {
            await Notifications.setBadgeCountAsync(data);
        }
    } catch (err) {
        console.warn('push: badge re-assert failed silently', err);
    }
}

// Module-level flag: prevents re-attempt within a single JS session.
// Resets on cold launch, hot reload, fresh bundle, or sign-out (via
// cleanupPushOnSignOut below) — so a different account signing in during
// the same JS session gets its own registration attempt rather than being
// skipped. Re-mounts of TabsLayout inside
// a session (deep link from a push, tab remounts) get skipped. The
// former limitation — user A signs out, user B signs in within one JS
// lifetime, and B's registration was skipped — is closed by the
// sign-out reset in cleanupPushOnSignOut.
let launchRegistrationAttempted = false;

// Launch-time push registration. Called from (tabs)/_layout.tsx once per JS
// session for the authenticated user. Deliberately NEVER prompts: it only
// refreshes + saves the token for users who have ALREADY granted permission
// (registerForPushNotifications returns null otherwise). This preserves the
// one-time iOS system prompt for a high-intent moment (sending a rec,
// accepting a friend — see promptPushAtHighIntent) instead of burning it on
// launch. Undetermined/denied users are left untouched here.
export async function ensurePushRegistrationOnLaunch(userId: string): Promise<void> {
    if (launchRegistrationAttempted) return;
    launchRegistrationAttempted = true;
    try {
        const token = await registerForPushNotifications();
        if (token) await savePushToken(token, userId);
    } catch (err) {
        console.warn('push: launch registration failed silently', err);
    }
}

// Sign-out hygiene for shared devices. MUST run BEFORE supabase.auth.signOut()
// — push_tokens RLS is owner-only, so the deletes below are only authorised
// while the outgoing user's session is still live. Called from
// src/lib/auth.ts signOut(). Three parts:
//
//   1. Delete this DEVICE's push_tokens rows for the outgoing user, so their
//      pushes stop being delivered to hardware the next account will hold.
//      Two delete keys: (user_id, device_id) for the current install's row,
//      and (user_id, expo_push_token) for rows accumulated by previous
//      installs of this same physical device — reinstall cycles create new
//      device_ids but Expo reissues the SAME token value (see DEVICE_ID_KEY
//      comment), and those old rows would still deliver. Deliberately two
//      separate .eq() deletes, not one .or() — the token value contains
//      brackets that would need escaping in PostgREST filter syntax. Rows for
//      the user's OTHER devices are intentionally left alone.
//   2. Reset the module-level launch flag so the next account to sign in
//      during this JS session gets its own registration attempt.
//   3. Zero the OS app-icon badge so the outgoing user's unread count doesn't
//      linger on the icon for whoever holds the device next.
//
// Best-effort throughout: sign-out is a user intent that must never be
// blocked by cleanup, so every step swallows its own failure. Known residual
// risk: offline sign-out can't reach the DB, so the token row survives until
// the reap path or the next authenticated cleanup.
export async function cleanupPushOnSignOut(userId: string): Promise<void> {
    // (2) Local flag first — cannot fail, and must happen even if the
    // network parts below do.
    launchRegistrationAttempted = false;

    // (3) Badge. Local OS call, independent of the session.
    try {
        await Notifications.setBadgeCountAsync(0);
    } catch (err) {
        console.warn('push: badge clear on sign-out failed', err);
    }

    // (1) Token rows — while still authenticated.
    try {
        const deviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
        if (deviceId) {
            const { error } = await supabase
                .from('push_tokens')
                .delete()
                .eq('user_id', userId)
                .eq('device_id', deviceId);
            if (error) throw error;
        }
    } catch (err) {
        console.warn('push: device-id token delete on sign-out failed', err);
    }
    try {
        // Permission-gated: returns null unless already granted, in which
        // case there's no live token to have delivered anything anyway.
        const token = await registerForPushNotifications();
        if (token) {
            const { error } = await supabase
                .from('push_tokens')
                .delete()
                .eq('user_id', userId)
                .eq('expo_push_token', token);
            if (error) throw error;
        }
    } catch (err) {
        console.warn('push: token-value delete on sign-out failed', err);
    }
}
