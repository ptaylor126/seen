/**
 * App Store / Play Store review prompt — native API only.
 *
 * We never build our own rating UI. `maybeRequestReview()` decides whether
 * the moment is right and, if so, hands off to the OS via
 * `StoreReview.requestReview()`; iOS/Android then decide whether to actually
 * surface the dialog (and rate-limit it system-side).
 *
 * Trigger logic — fire at most ONCE ever, never during the first session,
 * when EITHER condition is met (whichever comes first):
 *   A) received >= 3 recommendations AND >= 3 days since install
 *   B) >= 5 days since install
 *
 * The helper re-evaluates BOTH A and B on EVERY call, independent of which
 * call site invoked it — the call sites just invoke; all the logic lives
 * here. So a user who opens a rec on day 6 trips B at the rec-received site.
 *
 * State is AsyncStorage-only (install timestamp + the once-only flag). The
 * received-rec count is read live from the server (authoritative, survives
 * reinstall) — a head-only count, not persisted state. Everything is wrapped
 * so this can never crash, block, or gate a screen; on ANY error it fails
 * closed (returns without requesting a review).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import supabase from '@/lib/supabase';

// The bits of expo-store-review we use. Loaded lazily + guarded (see
// requestAndRecord) so a binary that predates the package — where the native
// module is absent and even importing it throws — degrades to a no-op instead
// of crashing any screen that imports this file.
type StoreReviewModule = {
    isAvailableAsync: () => Promise<boolean>;
    requestReview: () => Promise<void>;
};

const INSTALL_TS_KEY = 'seen_install_ts';
const REVIEW_REQUESTED_KEY = 'seen_review_requested';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RECS_FOR_A = 3;
const MIN_DAYS_FOR_A = 3;
const MIN_DAYS_FOR_B = 5;

// True only for the launch on which we first created the install timestamp.
// Used to guarantee we never fire during the user's first session, even if a
// clock anomaly made the day math pass.
let createdInstallTsThisSession = false;

/**
 * Reads the install timestamp, creating it on the first ever call. Returns
 * the timestamp in ms. The first-creation case also flips the in-memory
 * first-session flag.
 */
async function getOrCreateInstallTs(): Promise<number> {
    const existing = await AsyncStorage.getItem(INSTALL_TS_KEY);
    if (existing) {
        const parsed = Number(existing);
        if (Number.isFinite(parsed)) return parsed;
        // Corrupt value — treat as a fresh install rather than trusting it.
    }
    const now = Date.now();
    await AsyncStorage.setItem(INSTALL_TS_KEY, String(now));
    createdInstallTsThisSession = true;
    return now;
}

/**
 * Authoritative count of recs RECEIVED by the current user (head-only, no
 * rows transferred). Throws on any failure so the caller fails closed.
 */
async function fetchReceivedRecCount(): Promise<number> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user.id;
    if (!userId) throw new Error('no session');

    const { count, error } = await supabase
        .from('recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('to_user_id', userId);

    if (error) throw error;
    return count ?? 0;
}

/**
 * Evaluate the trigger conditions and, if met, ask the OS for a review.
 * Fire-and-forget: callers should NOT await-gate UI on this. Safe to call
 * from any screen, any number of times — it self-limits to once ever.
 */
export async function maybeRequestReview(): Promise<void> {
    try {
        // Once only, ever.
        if (await AsyncStorage.getItem(REVIEW_REQUESTED_KEY)) {
            console.log('[review] skip: already requested');
            return;
        }

        const installTs = await getOrCreateInstallTs();

        // Never during the first session (the launch we just created the
        // install ts on). Day math can't pass yet anyway, but be explicit.
        if (createdInstallTsThisSession) {
            console.log('[review] skip: first session (install ts just created)');
            return;
        }

        const daysSinceInstall = (Date.now() - installTs) / DAY_MS;

        // Condition B first — pure time, no network. If it's already met we
        // don't even need the count query.
        if (daysSinceInstall >= MIN_DAYS_FOR_B) {
            console.log(
                `[review] condition B met (daysSinceInstall=${daysSinceInstall.toFixed(2)} >= ${MIN_DAYS_FOR_B})`,
            );
            await requestAndRecord();
            return;
        }

        // Condition A needs the received-rec count. Fail closed: if the
        // count query errors (offline, no session), treat the count as
        // unknown, do NOT fire, and return early.
        if (daysSinceInstall >= MIN_DAYS_FOR_A) {
            let receivedCount: number;
            try {
                receivedCount = await fetchReceivedRecCount();
            } catch (err) {
                console.log(
                    '[review] skip: received-count query failed, failing closed',
                    err,
                );
                return;
            }

            if (receivedCount >= MIN_RECS_FOR_A) {
                console.log(
                    `[review] condition A met (received=${receivedCount} >= ${MIN_RECS_FOR_A}, daysSinceInstall=${daysSinceInstall.toFixed(2)} >= ${MIN_DAYS_FOR_A})`,
                );
                await requestAndRecord();
                return;
            }

            console.log(
                `[review] skip: A not met (received=${receivedCount}/${MIN_RECS_FOR_A}), B not met (days=${daysSinceInstall.toFixed(2)}/${MIN_DAYS_FOR_B})`,
            );
            return;
        }

        console.log(
            `[review] skip: neither condition met (days=${daysSinceInstall.toFixed(2)}, need ${MIN_DAYS_FOR_A}+recs or ${MIN_DAYS_FOR_B})`,
        );
    } catch (err) {
        // Absolute backstop — this must never crash a screen.
        console.log('[review] skip: unexpected error, failing closed', err);
    }
}

/**
 * Hand off to the OS review API and record that we've asked, so we never ask
 * again. The requested flag is set REGARDLESS of whether the OS shows the
 * dialog — `requestReview()` resolving is our "we asked" signal; the system
 * decides visibility and we don't get to retry.
 */
async function requestAndRecord(): Promise<void> {
    // Lazy, guarded load. In a binary built before expo-store-review was
    // added, the native module 'ExpoStoreReview' is missing and importing
    // the package THROWS — so we require() it here inside try/catch rather
    // than at module top, keeping that failure from ever reaching the
    // screens that import this file (Home + the rec screen).
    let StoreReview: StoreReviewModule;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        StoreReview = require('expo-store-review') as StoreReviewModule;
    } catch (err) {
        // Module unavailable — no-op, and DON'T set the one-shot flag, so it
        // can still fire on a future build where the native module exists.
        console.log('[review] skip: StoreReview unavailable (module load failed)', err);
        return;
    }

    let available = false;
    try {
        available = await StoreReview.isAvailableAsync();
    } catch (err) {
        console.log('[review] skip: StoreReview unavailable (isAvailableAsync threw)', err);
        return;
    }
    if (!available) {
        // No store review on this build/platform — don't burn the one-shot
        // flag, so it can fire on a future eligible launch.
        console.log('[review] skip: StoreReview unavailable (isAvailableAsync false)');
        return;
    }

    await StoreReview.requestReview();
    await AsyncStorage.setItem(REVIEW_REQUESTED_KEY, String(Date.now()));
    console.log('[review] requestReview() called; recorded one-shot flag');
}
