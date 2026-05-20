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

export function randomDisplayName(): string {
    const i = Math.floor(Math.random() * RANDOM_NAMES.length);
    return RANDOM_NAMES[i];
}

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
