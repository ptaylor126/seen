import { Platform, Share } from 'react-native';

import { type MediaType } from '@/lib/rating';
import supabase from '@/lib/supabase';

// Invite-loop client helpers: create a pending recommendation for someone
// not on Seen yet, share its landing-page link, and claim a link after
// signup. Server side: pending_recommendations + claim_pending_recommendation
// (20260712120000) and the get-pending-rec edge function behind
// seenrecs.com/r/.

const LANDING_URL_BASE = 'https://seenrecs.com/r/?t=';
// Exactly the generate_invite_token() shape: 16 base64url chars.
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

// Creates the pending rec and returns its share token. The insert supplies
// ONLY the four client-grantable columns (20260712120000's column-level
// INSERT grant) — id/token/created_at come from defaults, claim fields are
// RPC-only. The CALLER stamps public.titles via ensureTitle BEFORE this
// (and awaits it — unlike normal recs, the landing page needs the title
// row to render, so fire-and-forget isn't enough here).
export async function createPendingRec(args: {
    tmdbId: number;
    mediaType: MediaType;
    note: string | null;
}): Promise<string> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user.id;
    if (!userId) throw new Error('Not authenticated');

    const { data, error } = await supabase
        .from('pending_recommendations')
        .insert({
            from_user_id: userId,
            tmdb_id: args.tmdbId,
            media_type: args.mediaType,
            note: args.note,
        })
        .select('token')
        .single();
    if (error) throw error;
    return data.token;
}

// Opens the OS share sheet with the landing link. Returns true only on an
// explicit share (Share.sharedAction) — same semantics as the onboarding
// invite. On iOS the link rides as a separate `url` item for the rich link
// preview; Android ignores `url`, so it goes inline. A cancelled sheet is
// NOT an error and the pending row deliberately survives it — the sender
// can share the same link again.
export async function sharePendingRec(
    token: string,
    titleName: string,
): Promise<boolean> {
    const url = `${LANDING_URL_BASE}${token}`;
    const pitch = `I think you'd like ${titleName} — here's my rec on Seen.`;
    const result = await Share.share(
        Platform.OS === 'ios'
            ? { message: pitch, url }
            : { message: `${pitch} ${url}` },
    );
    return result?.action === Share.sharedAction;
}

// Accepts whatever the claimer pastes: the full landing URL (any host, we
// only care about the t= param) or a bare 16-char token. null = not
// recognisably an invite link.
export function parseInviteToken(input: string): string | null {
    const trimmed = input.trim();
    if (TOKEN_RE.test(trimmed)) return trimmed;
    const match = trimmed.match(/[?&]t=([A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])/);
    return match ? match[1] : null;
}

export type ClaimErrorCode =
    | 'not_found'
    | 'already_claimed'
    | 'own_rec'
    | 'unavailable'
    | 'generic';

// Friendly copy for the RPC's stable error messages — same pattern as the
// friend-request send errors (no raw Postgres text reaches the user).
export const CLAIM_ERROR_COPY: Record<ClaimErrorCode, string> = {
    not_found: "That link isn't valid — it may have been revoked.",
    already_claimed: 'This rec has already been claimed.',
    own_rec: "That's your own invite link — send it to a friend instead.",
    unavailable: "This recommendation isn't available.",
    generic: "Couldn't claim that link. Check your connection and try again.",
};

export type ClaimResult =
    | { ok: true; recId: string }
    | { ok: false; error: ClaimErrorCode };

// Claims a token: server-side this creates the real recommendation AND the
// friendship, and returns the new rec's id for routing. Error mapping keys
// off the RPC's stable message strings (20260712120000).
export async function claimPendingRec(token: string): Promise<ClaimResult> {
    const { data, error } = await supabase.rpc(
        'claim_pending_recommendation',
        { p_token: token },
    );
    if (error) {
        const msg = error.message ?? '';
        if (msg.includes('not found')) {
            return { ok: false, error: 'not_found' };
        }
        if (msg.includes('already claimed')) {
            return { ok: false, error: 'already_claimed' };
        }
        if (msg.includes('your own')) {
            return { ok: false, error: 'own_rec' };
        }
        if (msg.includes('not available')) {
            return { ok: false, error: 'unavailable' };
        }
        console.error('claim_pending_recommendation failed:', error);
        return { ok: false, error: 'generic' };
    }
    if (typeof data !== 'string' || data.length === 0) {
        return { ok: false, error: 'generic' };
    }
    return { ok: true, recId: data };
}
