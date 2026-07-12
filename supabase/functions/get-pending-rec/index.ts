// get-pending-rec — public read for the seenrecs.com/r/ invite landing page.
//
// GET ?token=<16-char base64url>. Returns ONLY what the page renders:
// sender display name, title/year/poster path, media type, note, and the
// claimed flag. No ids, no handles, no timestamps — the token is a
// capability the sender chose to hand out, and the payload is exactly the
// pitch they'd have texted anyway.
//
// Security model:
//   - verify_jwt = false (config.toml): the caller is an anonymous browser
//     tap from a text message. The token IS the auth — ~96 bits from
//     generate_invite_token(), unguessable in practice.
//   - Reads run on a service-role client because pending_recommendations
//     has NO public read surface (sender-only RLS). The service_role grant
//     is SELECT-only on this table (20260712120000) — a compromise of this
//     function's scope can read invites, not write anything.
//   - Token format is whitelist-checked BEFORE any DB work: junk and
//     malformed hammering is rejected for the cost of a regex.
//   - Rate limiting, honestly: edge functions have no built-in per-IP
//     limiter, and an in-isolate counter would be ephemeral theatre (each
//     isolate has its own memory, cold starts reset it). What actually
//     holds: Supabase's platform-level DDoS protection in front of the
//     function, the regex gate, and the 96-bit token space that makes
//     enumeration infeasible (10^9 guesses/sec for a year ≈ 4×10^-13 of
//     the space). If invite abuse ever shows up in the logs, the fix is
//     platform rate limits or a captcha at the page layer, not this
//     function.
//
// Claimed tokens still return the full payload with claimed: true — the
// page shows the title with a "already on Seen" state instead of a
// claimable rec (decided in step B; the link keeps working as a pointer
// to the app rather than dead-ending).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Origins allowed to call this from a browser. The landing page lives on
// seenrecs.com; localhost covers page development. Everything else gets no
// CORS headers (curl/native callers are unaffected — CORS only gates
// browsers).
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
        // Origin-dependent response — keep caches honest.
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
            // Invite state changes on claim — don't let intermediaries
            // cache a stale "claimable" response.
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
            // Malformed = indistinguishable from unknown, by design.
            return jsonResponse(req, { error: 'not_found' }, 404);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) {
            return jsonResponse(req, { error: 'misconfigured' }, 500);
        }
        const admin = createClient(supabaseUrl, serviceRoleKey);

        const { data: pending, error: pendingError } = await admin
            .from('pending_recommendations')
            .select('from_user_id, tmdb_id, media_type, note, claimed_at')
            .eq('token', token)
            .maybeSingle();
        if (pendingError) throw pendingError;
        if (!pending) {
            return jsonResponse(req, { error: 'not_found' }, 404);
        }

        // Sender profile + title row in parallel. The title was stamped by
        // ensureTitle at creation; the profile exists by FK. Either being
        // absent (deleted account edge, stamp failure) degrades to nulls
        // the page can cope with rather than a 500.
        const [profileResult, titleResult] = await Promise.all([
            admin
                .from('profiles')
                .select('display_name')
                .eq('id', pending.from_user_id)
                .maybeSingle(),
            admin
                .from('titles')
                .select('title, poster_path, release_date')
                .eq('tmdb_id', pending.tmdb_id)
                .eq('media_type', pending.media_type)
                .maybeSingle(),
        ]);
        if (profileResult.error) throw profileResult.error;
        if (titleResult.error) throw titleResult.error;

        const releaseDate = titleResult.data?.release_date ?? null;
        return jsonResponse(req, {
            senderName: profileResult.data?.display_name ?? null,
            title: titleResult.data?.title ?? null,
            year: releaseDate ? releaseDate.slice(0, 4) : null,
            posterPath: titleResult.data?.poster_path ?? null,
            mediaType: pending.media_type,
            note: pending.note,
            claimed: pending.claimed_at !== null,
        }, 200);
    } catch (err) {
        console.error('get-pending-rec failed:', err);
        return jsonResponse(req, { error: 'internal' }, 500);
    }
});
