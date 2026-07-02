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
    }
}

// Module-level flag: prevents re-attempt within a single JS session.
// Resets on cold launch, hot reload, or fresh bundle — the right
// scope (one attempt per JS lifetime). Re-mounts of TabsLayout inside
// a session (sign out + sign in, deep link from a push) get skipped.
// Limitation: if user A signs out and user B signs in within one JS
// lifetime, B's launch-registration is skipped. Rare for the alpha
// (single user per device); revisit if multi-account on one device
// becomes common.
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
