// Onboarding-only helpers. Kept in their own module rather than spread
// across the screens so the lists (random names, profanity) are easy
// to find and edit.

import { Alert } from 'react-native';

import { type ItemStatus } from '@/lib/item-status';
import { type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';
import { ensureTitle } from '@/lib/titles';

// Two-word "playful animal" names — retained for potential future use
// (e.g. a dice-randomize on a profile-edit screen). Not currently
// referenced by the onboarding flow; the display_name field is
// auto-derived from the handle at handle-submit time.
export const RANDOM_NAMES: readonly string[] = [
    'Curious Fox',
    'Quiet Owl',
    'Lazy Panda',
    'Wise Wolf',
    'Brave Bear',
    'Eager Eagle',
    'Calm Cat',
    'Gentle Deer',
    'Clever Crow',
    'Bright Beetle',
    'Sleepy Sloth',
    'Quick Quokka',
    'Happy Hare',
    'Loyal Lynx',
    'Bold Badger',
    'Patient Penguin',
    'Witty Whale',
    'Hungry Hedgehog',
    'Soft Seal',
    'Tiny Toad',
    'Mellow Moose',
    'Tidy Tapir',
    'Sunny Salamander',
    'Sneaky Squirrel',
    'Friendly Ferret',
    'Bouncy Bunny',
    'Curly Caterpillar',
    'Steady Stoat',
    'Wandering Wombat',
    'Yawning Yak',
];

// Profanity list — common English swears plus slurs. Matched with
// whole-word boundaries (\b...\b), case-insensitive, so "shit" blocks
// "shit" but lets "shitake" through (avoids the Scunthorpe problem
// the previous substring-match design suffered from).
//
// Add liberally; the regex compiled in containsProfanity() is rebuilt
// per call, but the cost is negligible for handles/display names.
export const PROFANITY_WORDS: readonly string[] = [
    // slurs
    'nigger',
    'nigga',
    'faggot',
    'tranny',
    'retard',
    'spic',
    'chink',
    'kike',
    'wetback',
    'gook',
    // common english swears
    'fuck',
    'shit',
    'cunt',
    'dick',
    'pussy',
    'asshole',
    'bitch',
    'bastard',
    'cock',
    'twat',
    'wanker',
    'piss',
];

export function containsProfanity(text: string): boolean {
    // Whole-word match: \b boundaries ensure "shit" matches "shit" but
    // not "shitake mushroom". Case-insensitive via the `i` flag.
    const pattern = new RegExp(`\\b(${PROFANITY_WORDS.join('|')})\\b`, 'i');
    return pattern.test(text);
}

export interface HandleValidationResult {
    valid: boolean;
    reason?: string;
}

// Mirrors the DB constraint `handle ~ '^[a-z0-9_]{3,20}$'` plus the
// profanity check. The taken-handle check is handled at submit time
// since it requires a Supabase round-trip; this function is for
// instant client-side feedback as the user types.
export function validateHandle(handle: string): HandleValidationResult {
    const trimmed = handle.trim();
    if (trimmed.length < 3) {
        return { valid: false, reason: 'At least 3 characters' };
    }
    if (trimmed.length > 20) {
        return { valid: false, reason: 'At most 20 characters' };
    }
    if (!/^[a-z0-9_]+$/.test(trimmed)) {
        return {
            valid: false,
            reason: 'Lowercase letters, numbers, underscore only',
        };
    }
    if (containsProfanity(trimmed)) {
        return { valid: false, reason: 'Please pick a different handle' };
    }
    return { valid: true };
}

// Normalized title shape for onboarding item writes — exactly the fields
// ensureTitle needs. Each onboarding screen maps its own raw item (a search
// result, a blended list summary) into this before writing.
export interface OnboardingTitle {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    backdropPath: string | null;
    releaseDate: string | null;
    originalLanguage: string;
    genreIds: number[];
}

// Single shared write path for onboarding item marking — the SAME items upsert
// + ensureTitle the onboarding steps use, DRYed here (the currently-watching
// step and the poster grid both go through this; no copy-pasted SQL). status
// semantics:
//   - 'watched'              → upsert watched + stamp watched_at; rating left
//                              untouched (undefined drops the key on conflict).
//   - 'watching' | 'watchlist' → upsert that status, nulling rating + watched_at
//                              (items_rating_only_when_watched_check requires
//                              rating be null off 'watched').
//   - null                   → REMOVE the item (delete the row). Used by the
//                              poster grid's tap-to-unmark; same delete shape
//                              the title screen's toggle-off uses.
// ensureTitle stamps the shared catalogue (non-blocking; it swallows its own
// errors) so the title renders in the library afterward.
export async function setOnboardingItemStatus(
    title: OnboardingTitle,
    status: ItemStatus | null,
): Promise<void> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user.id;
    if (!userId) throw new Error('Not authenticated');

    if (status === null) {
        const { error } = await supabase
            .from('items')
            .delete()
            .eq('user_id', userId)
            .eq('tmdb_id', title.tmdbId)
            .eq('media_type', title.mediaType);
        if (error) throw error;
        return;
    }

    const isWatched = status === 'watched';
    const { error } = await supabase.from('items').upsert(
        {
            user_id: userId,
            tmdb_id: title.tmdbId,
            media_type: title.mediaType,
            status,
            // undefined drops the rating key on 'watched' (preserve any
            // existing); null off 'watched' satisfies the CHECK constraint.
            rating: isWatched ? undefined : null,
            watched_at: isWatched ? new Date().toISOString() : null,
        },
        { onConflict: 'user_id,tmdb_id,media_type' },
    );
    if (error) throw error;

    void ensureTitle({
        tmdbId: title.tmdbId,
        mediaType: title.mediaType,
        title: title.title,
        posterPath: title.posterPath,
        backdropPath: title.backdropPath,
        releaseDate: title.releaseDate,
        originalLanguage: title.originalLanguage,
        genreIds: title.genreIds,
    });
}

// Shared "complete onboarding now" handler — called only from the
// final step (currently-watching) via Continue + Skip. Flips the
// profile flag and refreshes the shared profile context; the root
// layout's routing effect sees onboarded: true while we're still in
// /(onboarding) and redirects to /(tabs) automatically.
//
// We intentionally do NOT navigate explicitly here. Earlier versions
// invoked an onComplete callback that called router.replace('/(tabs)')
// alongside refreshProfile(), but that lost the race: the navigation
// could fire before the profile state propagated, the layout's
// effect would then run with stale onboarded=false + segments=(tabs),
// and bounce the user back to /(onboarding)/welcome. Letting the
// layout effect own forward navigation removes that race entirely.
export async function finishOnboarding(args: {
    refreshProfile: () => Promise<void>;
}): Promise<void> {
    const { refreshProfile } = args;
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (!userId) throw new Error('Not authenticated');
        const { error } = await supabase
            .from('profiles')
            .update({ onboarded: true })
            .eq('id', userId);
        if (error) throw error;
        await refreshProfile();
    } catch (err) {
        console.error('finishOnboarding failed:', err);
        Alert.alert(
            "Couldn't finish",
            err instanceof Error ? err.message : 'Unknown error',
        );
    }
}
