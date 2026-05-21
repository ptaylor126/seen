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
