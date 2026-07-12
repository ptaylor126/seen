// get-invite — public read for the seenrecs.com/i/ friend-invite landing
// page. Sibling of get-pending-rec (same gate/CORS/no-store pattern, one
// table swap): GET ?token=<16-char base64url> against invite_links,
// returning ONLY the inviter's display name and public avatar URL.
//
// invite_links tokens are PERMANENT and MULTI-CLAIM (never consumed), so
// there is no claimed state here — a token either resolves (revoked_at is
// null) or 404s. Security model is identical to get-pending-rec: the token
// is the capability (~96 bits), verify_jwt = false, service-role read
// because the table is owner-only under RLS (SELECT-only grant,
// 20260713120000), regex gate before any DB work, platform-level DDoS
// protection + token entropy in lieu of per-IP rate limiting.
//
// avatar_url is a full PUBLIC URL into the public-read avatars bucket
// (see src/lib/avatar-upload.ts getPublicUrl) — safe to hand to the page
// as-is; the page falls back to an initial circle when null.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = new Set([
    'https://seenrecs.com',
    'https://www.seenrecs.com',
    'http://localhost:4321',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
]);

// Exactly the generate_invite_token() shape: 16 base64url chars.
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('Origin') ?? '';
    if (!ALLOWED_ORIGINS.has(origin)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        Vary: 'Origin',
    };
}

function jsonResponse(
    req: Request,
    body: unknown,
    status: number,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders(req),
            'Content-Type': 'application/json',
            // Revocation/regeneration must take effect immediately.
            'Cache-Control': 'no-store',
        },
    });
}

Deno.serve(async (req: Request) => {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(req),
            });
        }
        if (req.method !== 'GET') {
            return jsonResponse(req, { error: 'method_not_allowed' }, 405);
        }

        const token = new URL(req.url).searchParams.get('token') ?? '';
        if (!TOKEN_RE.test(token)) {
            return jsonResponse(req, { error: 'not_found' }, 404);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse(req, { error: 'misconfigured' }, 500);
        }
        const admin = createClient(supabaseUrl, serviceRoleKey);

        const { data: link, error: linkError } = await admin
            .from('invite_links')
            .select('user_id')
            .eq('token', token)
            .is('revoked_at', null)
            .maybeSingle();
        if (linkError) throw linkError;
        if (!link) {
            return jsonResponse(req, { error: 'not_found' }, 404);
        }

        const { data: profile, error: profileError } = await admin
            .from('profiles')
            .select('display_name, avatar_url')
            .eq('id', link.user_id)
            .maybeSingle();
        if (profileError) throw profileError;

        return jsonResponse(req, {
            senderName: profile?.display_name ?? null,
            avatarUrl: profile?.avatar_url ?? null,
        }, 200);
    } catch (err) {
        console.error('get-invite failed:', err);
        return jsonResponse(req, { error: 'internal' }, 500);
    }
});
