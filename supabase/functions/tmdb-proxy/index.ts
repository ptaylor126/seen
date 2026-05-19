// TMDB API v4 proxy.
//
// Receives authenticated requests from the Seen app and forwards them to
// TMDB's REST API with the read-access token attached server-side. This is
// the ONLY place the TMDB token exists — the client bundle never sees it.
//
// Security model (TECHNICAL §3, tmdb-proxy entry):
//   - Caller must present a valid Supabase user JWT in the Authorization
//     header. Anything else → 401.
//   - The `path` query param is validated in two layers: a strict
//     character whitelist (alphanumerics, '/', '-', '_') runs first, then
//     a narrow allowlist of TMDB endpoints. Defence in depth against
//     query-string injection and against the proxy being repurposed as a
//     general TMDB gateway.
//   - Image URLs are NOT proxied. The client fetches posters and backdrops
//     directly from the TMDB CDN; the `configuration` endpoint here just
//     returns the base URLs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Adding to this list is a deliberate act. Keep narrow.
const ALLOWED_PATH_PATTERNS: RegExp[] = [
    /^search\/(movie|tv|multi)$/,
    /^movie\/\d+$/,
    /^tv\/\d+$/,
    /^configuration$/,
];

// Character filter runs BEFORE the allowlist regex. Catches '?', '&', '%',
// '..', and other URI mischief that might confuse the allowlist match.
const PATH_CHARACTER_FILTER = /^[a-zA-Z0-9/_-]+$/;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
        return jsonResponse({ error: 'method_not_allowed' }, 405);
    }

    // ---- 1. Authenticate the caller via their Supabase JWT.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        return jsonResponse({ error: 'unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !supabaseAnonKey) {
        return jsonResponse({ error: 'misconfigured' }, 500);
    }

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
    });

    const {
        data: { user },
        error: authError,
    } = await supabaseClient.auth.getUser();
    if (authError || !user) {
        return jsonResponse({ error: 'unauthorized' }, 401);
    }

    // ---- 2. Collect path + extra params from either the URL query string
    //         (curl/debug usage) or the JSON body (the standard path used by
    //         supabase.functions.invoke, which only sends POST + body).
    const url = new URL(req.url);
    let pathRaw = url.searchParams.get('path');
    const extraParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
        if (key === 'path') continue;
        extraParams.set(key, value);
    }

    if (req.method === 'POST') {
        try {
            const body = (await req.json()) as unknown;
            if (body && typeof body === 'object') {
                const bodyObj = body as Record<string, unknown>;
                if (typeof bodyObj.path === 'string') pathRaw = bodyObj.path;
                for (const [key, value] of Object.entries(bodyObj)) {
                    if (key === 'path') continue;
                    if (
                        typeof value === 'string' ||
                        typeof value === 'number' ||
                        typeof value === 'boolean'
                    ) {
                        extraParams.set(key, String(value));
                    }
                }
            }
        } catch {
            // Body wasn't JSON — fall through to query-string values.
        }
    }

    // ---- 3. Validate the TMDB path.
    const path = pathRaw;
    if (!path) {
        return jsonResponse({ error: 'missing_path' }, 400);
    }
    if (!PATH_CHARACTER_FILTER.test(path)) {
        return jsonResponse({ error: 'invalid_path' }, 400);
    }
    if (!ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
        return jsonResponse({ error: 'path_not_allowed' }, 400);
    }

    // ---- 4. Forward to TMDB with the read-access token, preserving
    //         every other param (page, query, language, etc.).
    const tmdbToken = Deno.env.get('TMDB_ACCESS_TOKEN');
    if (!tmdbToken) {
        return jsonResponse({ error: 'misconfigured' }, 500);
    }

    const tmdbUrl = new URL(`${TMDB_BASE_URL}/${path}`);
    for (const [key, value] of extraParams.entries()) {
        tmdbUrl.searchParams.set(key, value);
    }

    const tmdbResponse = await fetch(tmdbUrl, {
        headers: {
            Authorization: `Bearer ${tmdbToken}`,
            Accept: 'application/json',
        },
    });

    const body = await tmdbResponse.text();
    return new Response(body, {
        status: tmdbResponse.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
});
