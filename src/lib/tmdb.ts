/**
 * TMDB client wrapper.
 *
 * Every call goes through the `tmdb-proxy` Edge Function — the TMDB v4
 * read-access token is held server-side and never reaches the client
 * bundle. The Supabase client attaches the current user's access token to
 * `functions.invoke` automatically, so callers don't manage auth headers.
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
    const { data, error } = await supabase.functions.invoke<T>('tmdb-proxy', {
        body: { path, ...params },
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

// Configuration changes very rarely; caller is expected to fetch this once
// per app session and cache the result in memory (or persist it). Caching
// itself is intentionally not wired here — keep this file a thin wrapper.
export function getConfiguration(): Promise<TMDBConfiguration> {
    return callProxy('configuration');
}
