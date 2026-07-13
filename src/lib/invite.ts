import { Alert, Platform, Share } from 'react-native';

import supabase from '@/lib/supabase';

// Shared "Invite friends" action — used by the friends empty state,
// friends/add, and the onboarding invite step.
//
// ALWAYS shares the user's PERMANENT tokenized invite link
// (seenrecs.com/i/?t={invite_links.token}): the landing page shows who's
// inviting them, and claiming after signup auto-friends both sides via
// claim_invite_link (multi-claim — one link serves every friend it's sent
// to). A store link is deliberately NOT a fallback: it carries no token, so
// the recipient would arrive with no connection to the sender — worse than
// sharing nothing. If the row exists but has no active token (revoked), we
// mint one on demand against the same row; if anything fails we surface a
// clear error and share nothing.
//
// On iOS the link is a separate `url` item so iOS builds a rich link
// preview; Android's Share ignores `url`, so there the link goes inline.
// Returns true ONLY on an explicit share (Share.sharedAction) — the
// onboarding step gates its completion on that; other callers ignore it.
const INVITE_URL_BASE = 'https://seenrecs.com/i/?t=';
const DEFAULT_PITCH =
    'Join me on Seen — recommendations from friends you actually trust.';

// User-facing copy when we can't produce an invite link. The two failure
// branches (read vs. mint) log DIFFERENTLY so we can tell which half broke in
// the wild, but they show the user the same message.
const FAIL_TITLE = "Couldn't create your invite link";
const FAIL_BODY = 'Something went wrong on our end. Please try again.';

// Looking up the caller's invite link resolves to one of three states, so
// shareInvite can share, mint-then-share, or fail loudly as appropriate.
type InviteUrlLookup =
    | { status: 'ok'; url: string }
    | { status: 'mintable'; userId: string }
    | { status: 'error'; cause: unknown };

async function fetchOwnInviteUrl(): Promise<InviteUrlLookup> {
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const userId = session?.user.id;
        if (!userId) return { status: 'error', cause: 'no session' };

        // No revoked_at filter (unlike a plain read): we need to see the row
        // even when its token is revoked, to tell "mintable" from "no row".
        const { data, error } = await supabase
            .from('invite_links')
            .select('token, revoked_at')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) return { status: 'error', cause: error };
        if (!data) return { status: 'error', cause: 'no invite_links row' };

        // Active token → shareable. Revoked (or somehow-empty) token →
        // mint on demand against the same row (RLS: invite_links_update_own).
        if (data.revoked_at === null && data.token) {
            return { status: 'ok', url: `${INVITE_URL_BASE}${data.token}` };
        }
        return { status: 'mintable', userId };
    } catch (err) {
        return { status: 'error', cause: err };
    }
}

// Mint a fresh token for the caller's OWN invite_links row and return its
// share URL. Throws on any failure (RPC or update) — callers surface it and
// share nothing. The partial-unique index on (token) where revoked_at is null
// means a collision raises from the update rather than being swallowed.
async function mintInviteUrl(userId: string): Promise<string> {
    const { data: newToken, error: rpcError } = await supabase.rpc(
        'generate_invite_token',
    );
    if (rpcError) throw rpcError;
    if (typeof newToken !== 'string') {
        throw new Error('generate_invite_token returned no value');
    }
    const { error: updateError } = await supabase
        .from('invite_links')
        .update({ token: newToken, revoked_at: null })
        .eq('user_id', userId);
    if (updateError) throw updateError;
    return `${INVITE_URL_BASE}${newToken}`;
}

export async function shareInvite(pitch?: string): Promise<boolean> {
    const message = pitch ?? DEFAULT_PITCH;

    const lookup = await fetchOwnInviteUrl();
    let url: string;
    if (lookup.status === 'ok') {
        url = lookup.url;
    } else if (lookup.status === 'mintable') {
        try {
            url = await mintInviteUrl(lookup.userId);
        } catch (err) {
            // MINT failure — kept distinct from the read failure below so the
            // logs say which half broke.
            console.error(
                'invite share: could not mint a new invite token',
                err,
            );
            Alert.alert(FAIL_TITLE, FAIL_BODY);
            return false;
        }
    } else {
        // READ failure (no session / no row / query error).
        console.error(
            'invite share: could not read the invite link',
            lookup.cause,
        );
        Alert.alert(FAIL_TITLE, FAIL_BODY);
        return false;
    }

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
