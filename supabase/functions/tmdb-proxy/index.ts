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
    // /watch/providers returns JustWatch-sourced availability data per
    // region. Display requirements (attribution to JustWatch + use of
    // the provider link) live on the client where this data is rendered.
    /^movie\/\d+\/watch\/providers$/,
    /^tv\/\d+\/watch\/providers$/,
    // Single season's full episode list (per-episode name/overview/air_date/
    // still) for episode-scoped chats. Anchored to the season endpoint only —
    // no /episode/{m} sub-path, no widening.
    /^tv\/\d+\/season\/\d+$/,
    // Person lookup + combined cast/crew filmography for the
    // search-by-person feature. combined_credits returns both movie
    // and TV credits in one response so we don't need to hit
    // movie_credits and tv_credits separately.
    /^person\/\d+$/,
    /^person\/\d+\/combined_credits$/,
    /^configuration$/,
    // --- Onboarding poster-grid blend (TMDB list endpoints). Exact paths
    //     only; list params (page, with_genres, sort_by) ride as forwarded
    //     query params in the request body, NOT in the path string.
    /^trending\/(movie|tv)\/week$/,
    /^(movie|tv)\/popular$/,
    /^(movie|tv)\/top_rated$/,
    /^discover\/(movie|tv)$/,
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
    // Top-level try/catch so any unhandled rejection surfaces as a
    // structured JSON 500 with the actual error message in the body —
    // otherwise the Edge runtime returns plain "Internal Server Error"
    // text and the client has nothing to debug from.
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (req.method !== 'GET' && req.method !== 'POST') {
            return jsonResponse({ error: 'method_not_allowed' }, 405);
        }

        // ---- 1. Authenticate the caller via their Supabase JWT.
        //
        // We pass the JWT to auth.getUser(jwt) EXPLICITLY rather than
        // relying on global.headers + auth.getUser(). The latter looks
        // fine on paper but in practice the GoTrue client uses its
        // OWN session (empty in this fresh server-side client), not
        // the global Authorization header — so it returns no user
        // even when a valid user JWT is present in the request.
        // Passing the JWT directly to getUser() validates it against
        // the auth server unambiguously.
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.warn('tmdb-proxy: missing or malformed auth header');
            return jsonResponse(
                { error: 'unauthorized', detail: 'missing or malformed Authorization' },
                401,
            );
        }
        const jwt = authHeader.slice('Bearer '.length);

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
        if (!supabaseUrl || !supabaseAnonKey) {
            return jsonResponse({ error: 'misconfigured' }, 500);
        }

        const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);

        const {
            data: { user },
            error: authError,
        } = await supabaseClient.auth.getUser(jwt);
        if (authError || !user) {
            console.warn('tmdb-proxy auth.getUser rejected jwt:', {
                error: authError?.message,
                userPresent: !!user,
            });
            return jsonResponse(
                {
                    error: 'unauthorized',
                    detail: authError?.message ?? 'no user',
                },
                401,
            );
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

        // Outbound fetch is the most likely failure surface (network blip,
        // TLS handshake, DNS). Catch it specifically so the client sees
        // "upstream_fetch_failed" with the underlying error message rather
        // than a generic 500.
        //
        // `Accept-Encoding: identity` disables compression on the upstream
        // response. The Supabase Edge runtime can mis-handle chunked /
        // gzipped responses from some upstreams, throwing "unexpected end
        // of file" mid-body-read. Forcing the upstream to send an
        // identity-encoded body removes that whole class of failure;
        // TMDB JSON responses are small enough that there's no real
        // bandwidth cost.
        let tmdbResponse: Response;
        try {
            tmdbResponse = await fetch(tmdbUrl, {
                headers: {
                    Authorization: `Bearer ${tmdbToken}`,
                    Accept: 'application/json',
                    'Accept-Encoding': 'identity',
                },
            });
        } catch (fetchErr) {
            const detail =
                fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            console.error('tmdb-proxy upstream fetch failed:', {
                path,
                url: tmdbUrl.toString(),
                detail,
            });
            return jsonResponse(
                { error: 'upstream_fetch_failed', detail, path },
                502,
            );
        }

        // The body read is the historical failure point — wrap it
        // separately so we can distinguish "couldn't connect" from
        // "connected but the stream ended early."
        let body: string;
        try {
            body = await tmdbResponse.text();
        } catch (readErr) {
            const detail =
                readErr instanceof Error ? readErr.message : String(readErr);
            console.error('tmdb-proxy upstream body read failed:', {
                path,
                status: tmdbResponse.status,
                detail,
            });
            return jsonResponse(
                {
                    error: 'upstream_body_read_failed',
                    detail,
                    path,
                    status: tmdbResponse.status,
                },
                502,
            );
        }

        // Log non-2xx upstream responses so dashboard logs reveal which
        // tmdb_ids TMDB itself is returning errors for.
        if (!tmdbResponse.ok) {
            console.warn('tmdb-proxy upstream non-2xx:', {
                path,
                status: tmdbResponse.status,
                body: body.slice(0, 200),
            });
        }
        return new Response(body, {
            status: tmdbResponse.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error('tmdb-proxy unhandled error:', { detail, stack });
        return jsonResponse({ error: 'unhandled', detail }, 500);
    }
});
