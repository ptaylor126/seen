// Onboarding-only helpers. Kept in their own module rather than spread
// across the screens so the lists (random names, profanity) are easy
// to find and edit.

import { Alert } from 'react-native';

import supabase from '@/lib/supabase';

// Two-word "playful animal" names used for the Skip path on the
// display-name step and the dice-randomize button. List is intentionally
// short — variety matters less than every option being readable. Add
// liberally; nothing here depends on the order.
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

// Tiny profanity list — kept here intentionally short and focused on
// slurs. Case-insensitive substring match means false positives are
// possible ("scunthorpe problem"); we accept that trade-off for MVP
// because the alternative is shipping a 300-word block list and we'd
// rather under-block than over-block.
//
// IMPORTANT: Keep this list small and only include unambiguous slurs.
// Generic profanity (swear words) is not what this guards — it guards
// against handles/display names that would be hostile in someone
// else's notification feed.
export const PROFANITY_WORDS: readonly string[] = [
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
];

export function randomDisplayName(): string {
    const i = Math.floor(Math.random() * RANDOM_NAMES.length);
    return RANDOM_NAMES[i];
}

export function containsProfanity(text: string): boolean {
    const lower = text.toLowerCase();
    return PROFANITY_WORDS.some((word) => lower.includes(word));
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

// Shared "complete onboarding now" handler called by the Skip button
// on steps 4-6 and the final Continue on step 6. Flips the profile
// flag, refreshes the shared profile context so the root layout's
// routing effect sees onboarded: true, then invokes onComplete which
// each screen wires to a typed router.replace('/(tabs)'). The
// explicit replace inside onComplete avoids a one-frame flash of
// the onboarding screen while React schedules the layout effect.
//
// onComplete is a callback (not a router) so the helper can stay
// outside Expo Router's typed-route generic surface.
export async function finishOnboarding(args: {
    onComplete: () => void;
    refreshProfile: () => Promise<void>;
}): Promise<void> {
    const { onComplete, refreshProfile } = args;
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
        onComplete();
    } catch (err) {
        console.error('finishOnboarding failed:', err);
        Alert.alert(
            "Couldn't finish",
            err instanceof Error ? err.message : 'Unknown error',
        );
    }
}
