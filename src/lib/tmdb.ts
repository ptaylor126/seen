/**
 * TMDB client wrapper.
 *
 * Every call goes through the `tmdb-proxy` Edge Function — the TMDB v4
 * read-access token is held server-side and never reaches the client
 * bundle. `callProxy` reads the current session explicitly and attaches
 * `Authorization: Bearer <access_token>` to `functions.invoke`: while
 * supabase-js v2 *does* propagate session JWTs to the FunctionsClient
 * via an internal listener, that propagation is event-driven and racy
 * just after `signInWithIdToken` — the onboarding screens were hitting
 * the proxy before the cached header had been updated and getting back
 * 401s. Attaching the header explicitly closes that race for every
 * call site, not just onboarding.
 *
 * Image URLs are NOT proxied: posters and backdrops come straight from the
 * TMDB CDN via `imageUrl()` (per TECHNICAL §3 and DESIGN's image-forward
 * direction — letting `expo-image` cache the CDN responses directly is the
 * right shape for a high-traffic visual app).
 *
 * Type shapes are intentionally minimal: only the fields the app currently
 * reads. Extend when a new field is genuinely needed, not pre-emptively.
 */
import supabase from './supabase';

// ---------------------------------------------------------------------------
// Image CDN
// ---------------------------------------------------------------------------

const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

export type TMDBImageSize = 'w185' | 'w342' | 'w500' | 'w780' | 'original';

/**
 * Build a direct TMDB CDN URL. `path` is the `poster_path` / `backdrop_path`
 * value returned by TMDB (already includes a leading slash, e.g.
 * `/abc123.jpg`).
 */
export function imageUrl(path: string, size: TMDBImageSize): string {
    return `${TMDB_IMAGE_BASE_URL}${size}${path}`;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface TMDBMovieSummary {
    id: number;
    title: string;
    original_title: string;
    overview: string;
    release_date: string;
    poster_path: string | null;
    backdrop_path: string | null;
    vote_average: number;
    popularity: number;
}

export interface TMDBTVSummary {
    id: number;
    name: string;
    original_name: string;
    overview: string;
    first_air_date: string;
    poster_path: string | null;
    backdrop_path: string | null;
    vote_average: number;
    popularity: number;
}

export interface TMDBPersonSummary {
    id: number;
    name: string;
    profile_path: string | null;
    popularity: number;
    // /search/multi responses populate this on person results; it tells
    // us what to label the row with ("Actor" / "Director" / "Writer").
    // Optional because not every TMDB response shape includes it.
    known_for_department?: string;
}

// /person/{id} response — slim, only the fields the filmography
// screen renders. Biography is intentionally NOT pulled for v1;
// adding it later is a one-field extension here.
export interface TMDBPersonDetail {
    id: number;
    name: string;
    profile_path: string | null;
    known_for_department: string | null;
}

// A single credit row returned by /person/{id}/combined_credits. The
// endpoint returns BOTH movie and TV credits in one response (with
// `media_type` as the discriminator) and includes `character` on cast
// entries / `job` on crew entries. Title fields differ by media type
// (`title` + `release_date` for movies, `name` + `first_air_date` for
// TV) — both included so consumers can pick.
export interface TMDBPersonCredit {
    id: number;
    media_type: 'movie' | 'tv';
    poster_path: string | null;
    // Movie titles use `title` + `release_date`; TV uses `name` +
    // `first_air_date`. TMDB populates whichever pair matches.
    title?: string;
    name?: string;
    release_date?: string;
    first_air_date?: string;
    // Cast entries carry `character`; crew entries carry `job`.
    character?: string;
    job?: string;
    popularity: number;
}

export interface TMDBPersonCombinedCredits {
    id: number;
    cast: TMDBPersonCredit[];
    crew: TMDBPersonCredit[];
}

// Discriminated union for /search/multi results. The `media_type` field is
// the discriminator and is only present on /search/multi responses (not on
// /search/movie or /search/tv, where the result type is implicit).
export type TMDBMediaItem =
    | (TMDBMovieSummary & { media_type: 'movie' })
    | (TMDBTVSummary & { media_type: 'tv' })
    | (TMDBPersonSummary & { media_type: 'person' });

export interface TMDBSearchResult<T> {
    page: number;
    results: T[];
    total_pages: number;
    total_results: number;
}

export interface TMDBMovie {
    id: number;
    title: string;
    original_title: string;
    overview: string;
    tagline: string;
    release_date: string;
    poster_path: string | null;
    backdrop_path: string | null;
    runtime: number | null;
    vote_average: number;
    genres: Array<{ id: number; name: string }>;
}

export interface TMDBTV {
    id: number;
    name: string;
    original_name: string;
    overview: string;
    tagline: string;
    first_air_date: string;
    last_air_date: string | null;
    poster_path: string | null;
    backdrop_path: string | null;
    number_of_seasons: number;
    number_of_episodes: number;
    vote_average: number;
    genres: Array<{ id: number; name: string }>;
    status: string;
}

// Watch providers — JustWatch-sourced availability data per region.
// IMPORTANT LICENSING: the `link` field on each region's entry is the
// canonical JustWatch deep link for the title in that region and is the
// ONLY URL we may navigate users to from this data. Per TMDB's terms,
// fabricating direct deep-links into individual provider apps (Netflix,
// Apple TV, etc.) is not permitted, and any UI that surfaces this data
// must visibly attribute JustWatch. Provider logos can be rendered as
// decorative identifiers but must not be tappable to any URL other than
// the JustWatch link below.
export interface TMDBWatchProvider {
    provider_id: number;
    provider_name: string;
    logo_path: string;
    display_priority: number;
}

export interface TMDBWatchProvidersRegion {
    link: string;
    flatrate?: TMDBWatchProvider[];
    rent?: TMDBWatchProvider[];
    buy?: TMDBWatchProvider[];
    // `ads` and `free` also appear on some titles. Not surfaced for v1
    // to keep the section focused on the three buckets the user cares
    // about (subscription vs rent vs buy).
}

export interface TMDBWatchProviders {
    id: number;
    // Region key is an ISO 3166-1 alpha-2 code ('US', 'GB', 'DE', …).
    // Empty object {} for titles with no availability anywhere — handle
    // that as "no providers" in the UI rather than an error.
    results: Record<string, TMDBWatchProvidersRegion>;
}

export interface TMDBConfiguration {
    images: {
        base_url: string;
        secure_base_url: string;
        poster_sizes: string[];
        backdrop_sizes: string[];
        still_sizes: string[];
        profile_sizes: string[];
        logo_sizes: string[];
    };
    change_keys: string[];
}

// ---------------------------------------------------------------------------
// Proxy invocation
// ---------------------------------------------------------------------------

type ProxyParams = Record<string, string | number | boolean>;

async function callProxy<T>(path: string, params: ProxyParams = {}): Promise<T> {
    // Read the session and attach Authorization explicitly. See the
    // file header for why — the auto-attach in functions.invoke is
    // racy right after sign-in.
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const headers = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : undefined;
    // TEMP diagnostic for the persistent 401 — correlate this client
    // log with the Edge Function logs in the Supabase dashboard.
    console.log('[tmdb-proxy] callProxy:', {
        path,
        hasSession: !!session,
        hasToken: !!session?.access_token,
        tokenStart: session?.access_token?.slice(0, 30),
        expiresAt: session?.expires_at,
    });

    const { data, error } = await supabase.functions.invoke<T>('tmdb-proxy', {
        body: { path, ...params },
        headers,
    });

    if (error) {
        // FunctionsHttpError carries the original Response on `.context`.
        // Pull the body if we can so the thrown message is actionable.
        const ctx = (error as { context?: unknown }).context;
        let detail = '';
        let status: number | undefined;
        if (ctx instanceof Response) {
            status = ctx.status;
            try {
                detail = await ctx.text();
            } catch {
                /* response body already consumed or unreadable */
            }
        }
        // 401 from the proxy means the JWT we just sent was rejected
        // by auth.getUser — most commonly because the user it refers
        // to has been deleted (server-side, by an admin or the
        // delete_account flow). Sign out so the root layout's routing
        // effect picks up the now-empty session and routes the user
        // back to /(auth)/sign-in. Re-signing in with Apple mints a
        // fresh session against the current (live) user.
        if (status === 401) {
            console.warn('[tmdb-proxy] 401 — signing out stale session');
            await supabase.auth.signOut();
        }
        const prefix = status ? `tmdb-proxy ${status}` : 'tmdb-proxy';
        throw new Error(`${prefix}: ${detail || error.message}`);
    }

    if (data === null) {
        throw new Error('tmdb-proxy returned no data');
    }

    return data;
}

// ---------------------------------------------------------------------------
// Public API — one function per allowlisted TMDB path
// ---------------------------------------------------------------------------

export function searchMulti(
    query: string,
    page = 1,
): Promise<TMDBSearchResult<TMDBMediaItem>> {
    return callProxy('search/multi', { query, page });
}

export function searchMovies(
    query: string,
    page = 1,
): Promise<TMDBSearchResult<TMDBMovieSummary>> {
    return callProxy('search/movie', { query, page });
}

export function searchTV(
    query: string,
    page = 1,
): Promise<TMDBSearchResult<TMDBTVSummary>> {
    return callProxy('search/tv', { query, page });
}

export function getMovie(tmdbId: number): Promise<TMDBMovie> {
    return callProxy(`movie/${tmdbId}`);
}

export function getTV(tmdbId: number): Promise<TMDBTV> {
    return callProxy(`tv/${tmdbId}`);
}

export function getMovieWatchProviders(
    tmdbId: number,
): Promise<TMDBWatchProviders> {
    return callProxy(`movie/${tmdbId}/watch/providers`);
}

export function getTVWatchProviders(
    tmdbId: number,
): Promise<TMDBWatchProviders> {
    return callProxy(`tv/${tmdbId}/watch/providers`);
}

export function getPerson(personId: number): Promise<TMDBPersonDetail> {
    return callProxy(`person/${personId}`);
}

export function getPersonCombinedCredits(
    personId: number,
): Promise<TMDBPersonCombinedCredits> {
    return callProxy(`person/${personId}/combined_credits`);
}

// Configuration changes very rarely; caller is expected to fetch this once
// per app session and cache the result in memory (or persist it). Caching
// itself is intentionally not wired here — keep this file a thin wrapper.
export function getConfiguration(): Promise<TMDBConfiguration> {
    return callProxy('configuration');
}
