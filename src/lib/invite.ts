import { Platform, Share } from 'react-native';

import supabase from '@/lib/supabase';

// Shared "Invite friends" action — used by the friends empty state,
// friends/add, and the onboarding invite step.
//
// Shares the user's PERMANENT tokenized invite link
// (seenrecs.com/i/?t={invite_links.token}): the landing page shows who's
// inviting them, and claiming after signup auto-friends both sides via
// claim_invite_link (multi-claim — one link serves every friend it's sent
// to). If the token can't be fetched (offline, revoked-with-no-regen edge),
// falls back to the plain App Store link so the share NEVER dead-ends.
//
// On iOS the link is a separate `url` item so iOS builds a rich link
// preview; Android's Share ignores `url`, so there the link goes inline.
// Returns true only on an explicit share (Share.sharedAction) — the
// onboarding step gates its completion on that; other callers ignore it.
const APP_STORE_URL = 'https://apps.apple.com/app/id6775920785';
const INVITE_URL_BASE = 'https://seenrecs.com/i/?t=';
const DEFAULT_PITCH =
    'Join me on Seen — recommendations from friends you actually trust.';

async function fetchOwnInviteUrl(): Promise<string | null> {
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (!userId) return null;
        const { data, error } = await supabase
            .from('invite_links')
            .select('token')
            .eq('user_id', userId)
            .is('revoked_at', null)
            .maybeSingle();
        if (error || !data?.token) return null;
        return `${INVITE_URL_BASE}${data.token}`;
    } catch {
        return null;
    }
}

export async function shareInvite(pitch?: string): Promise<boolean> {
    const message = pitch ?? DEFAULT_PITCH;
    const url = (await fetchOwnInviteUrl()) ?? APP_STORE_URL;
    try {
        const result = await Share.share(
            Platform.OS === 'ios'
                ? { message, url }
                : { message: `${message} ${url}` },
        );
        return result?.action === Share.sharedAction;
    } catch (err) {
        console.error('invite share failed:', err);
        return false;
    }
}
