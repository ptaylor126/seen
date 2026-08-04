/**
 * App Store / Play Store review prompt — native API only.
 *
 * We never build our own rating UI. `maybeRequestReviewAfterRecRating()`
 * decides whether the moment is right and, if so, hands off to the OS via
 * `StoreReview.requestReview()`; iOS/Android then decide whether to actually
 * surface the dialog (and rate-limit it system-side).
 *
 * Trigger — fire at most ONCE ever, never during the first session, on LOOP
 * COMPLETION: the user submitted a rating >= 3.5 stars (>= 7 on our 1-10
 * half-star scale) for a title that reached them as a recommendation (the
 * rating advanced >= 1 open rec to 'watched' — applyWatchedRating reports
 * the count). That's the one moment the product has demonstrably worked:
 * a friend's rec landed, got watched, and was liked. No time-based trigger —
 * the old condition B (5 days since install, zero engagement) fired unearned
 * and dominated; removed 2026-08-02.
 *
 * The RatingSheet is the single component every rating flows through
 * (rec screen, title page, favorites all mount it); it reports the event
 * facts AFTER its close animation completes, so the OS dialog never appears
 * over the dismissing sheet. All decision logic lives HERE — the sheet just
 * reports what happened.
 *
 * State is AsyncStorage-only (install timestamp + the once-only flag).
 * Everything is wrapped so this can never crash, block, or gate a screen;
 * on ANY error it fails closed (returns without requesting a review).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

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

// >= 3.5 stars on the 1-10 half-star scale (odd = ½, even = whole).
const MIN_RATING_FOR_PROMPT = 7;

// True only for the launch on which we first created the install timestamp.
// Used to guarantee we never fire during the user's first session, even
// though a loop completion (friend rec'd it, they watched AND rated it)
// in a literal first session is already vanishingly rare.
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
 * Stamp the install timestamp at app entry. Called fire-and-forget from the
 * authenticated layout's launch effect. This used to happen implicitly (the
 * old time-based trigger ran on every Home focus, creating the ts on first
 * launch); with the trigger now event-based, the ts must still be created at
 * FIRST LAUNCH — not lazily at the first rating event, which could be weeks
 * in and would wrongly mark that session as the "first session", skipping a
 * legitimate loop completion. Existing installs already have the key; this
 * is a no-op for them.
 */
export async function ensureInstallTimestamp(): Promise<void> {
    try {
        await getOrCreateInstallTs();
    } catch {
        // Best-effort; the trigger fails closed without it.
    }
}

/**
 * Loop-completion trigger: the RatingSheet reports a completed rating
 * submit (after its close animation) and this decides. Fire-and-forget:
 * callers should NOT await-gate UI on this. Self-limits to once ever.
 *
 *   rating           — the submitted items.rating (1-10 half-star), or null
 *                      for a skip (never fires).
 *   advancedRecCount — how many open recs the submit advanced to 'watched'
 *                      (from applyWatchedRating). 0 = not a rec'd title.
 */
export async function maybeRequestReviewAfterRecRating(args: {
    rating: number | null;
    advancedRecCount: number;
}): Promise<void> {
    try {
        // The event test: a liked rating on a rec'd title.
        if (args.rating === null || args.rating < MIN_RATING_FOR_PROMPT) {
            console.log(
                `[review] skip: rating ${args.rating ?? 'null'} < ${MIN_RATING_FOR_PROMPT}`,
            );
            return;
        }
        if (args.advancedRecCount < 1) {
            console.log('[review] skip: rating did not resolve any rec');
            return;
        }

        // Once only, ever.
        if (await AsyncStorage.getItem(REVIEW_REQUESTED_KEY)) {
            console.log('[review] skip: already requested');
            return;
        }

        await getOrCreateInstallTs();

        // Never during the first session (the launch we just created the
        // install ts on).
        if (createdInstallTsThisSession) {
            console.log('[review] skip: first session (install ts just created)');
            return;
        }

        console.log(
            `[review] loop completion (rating=${args.rating}, advancedRecs=${args.advancedRecCount}) — requesting review`,
        );
        await requestAndRecord();
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
    // screens that import this file.
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
