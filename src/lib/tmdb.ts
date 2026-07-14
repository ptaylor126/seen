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
    // vote_count + adult come back on every /search/*, /discover/*, and list
    // (/popular, /trending, /top_rated) response. The poster-grid blend filters
    // on them client-side — the vote-count floor is the primary recognisability
    // lever; `adult` is a safety gate.
    vote_count: number;
    adult?: boolean;
    popularity: number;
    // genre_ids + original_language are present on every /search/* and
    // /discover/* response. Exposed here so insert sites and the
    // backfill can stamp items.genre_ids / items.original_language
    // without an extra detail round-trip.
    genre_ids: number[];
    original_language: string;
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
    // TV list/search responses carry vote_count; `adult` is a movie-only field
    // (absent on TV → stays undefined), typed here so the shared client filter
    // reads both media the same way.
    vote_count: number;
    adult?: boolean;
    popularity: number;
    genre_ids: number[];
    original_language: string;
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

// Slim cast-member shape — only the fields the title-screen cast row
// renders. TMDB returns more (gender, popularity, known_for_department,
// cast_id, credit_id, original_name, adult) — added on demand if a
// future surface needs them.
export interface TMDBCastMember {
    id: number;
    name: string;
    character: string | null;
    profile_path: string | null;
    order: number;  // billing order; 0 = top-billed
}

// Slim crew-member shape for the movie title-screen "Directed by /
// Written by" credit line. TMDB also returns department, credit_id,
// gender, popularity, original_name, adult — added on demand. `job`
// is the discriminator for directors ('Director') and writers
// ('Writer' / 'Screenplay' / 'Story') in the title-screen filter.
export interface TMDBCrewMember {
    id: number;
    name: string;
    job: string;
    profile_path: string | null;
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
    // ISO 639-1 code (e.g. 'en', 'ja', 'ko'). Stored as-is on
    // items.original_language; mapped to a display name at render
    // time via the static LANGUAGE_NAMES map in src/lib/languages.ts
    // (Hermes' Intl.DisplayNames isn't reliable enough to depend on
    // — see that file's header).
    original_language: string;
    // Populated only when the caller passes { appendCredits: true } to
    // getMovie() — flows through as TMDB's append_to_response=credits
    // query param. cast drives the title-screen Cast row; crew drives
    // the "Directed by / Written by" line on movies (filtered by
    // `job`). TV's credits stay cast-only because TV doesn't have a
    // single film-level director — directing is per-episode, and a
    // TV-equivalent of this surface would use `created_by` instead.
    credits?: { cast: TMDBCastMember[]; crew?: TMDBCrewMember[] };
    // Populated only when the caller passes { appendVideos: true } — flows
    // through as append_to_response=videos. Drives the title-screen trailer.
    videos?: { results: TMDBVideo[] };
}

// A trailer/teaser video row from TMDB's `videos` append. `key` is the
// YouTube video id; `site` distinguishes YouTube from Vimeo etc.
export interface TMDBVideo {
    key: string;
    name: string;
    site: string; // 'YouTube' | 'Vimeo' | …
    type: string; // 'Trailer' | 'Teaser' | 'Clip' | …
    official: boolean;
    published_at: string; // ISO
    iso_639_1: string; // 'en', 'ja', …
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
    original_language: string;
    credits?: { cast: TMDBCastMember[] };
    videos?: { results: TMDBVideo[] };
    // Always present on the /tv/{id} detail response (no extra append needed).
    // Drives episode-progress clamping — see selectTrailerKey's neighbour
    // buildBounds in episode-progress. season_number 0 = "Specials".
    seasons?: TMDBSeason[];
}

// One season entry from the TV detail's `seasons` array. episode_count can be
// 0 or missing on odd data (future/unaired seasons) — callers clamp leniently.
export interface TMDBSeason {
    season_number: number;
    episode_count: number;
    name: string;
}

// One episode from the tv/{id}/season/{n} proxy endpoint. Only the fields the
// episode list + episode-chat door render (verified against the live proxy).
export interface TMDBEpisode {
    episode_number: number;
    name: string;
    overview: string;
    air_date: string | null;
    still_path: string | null;
    runtime: number | null;
}

// A single season's full detail — its episodes.
export interface TMDBSeasonDetail {
    season_number: number;
    name: string;
    episodes: TMDBEpisode[];
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

    const invoke = () =>
        supabase.functions.invoke<T>('tmdb-proxy', {
            body: { path, ...params },
            headers,
        });

    // HTTP status of a FunctionsHttpError (the original Response rides on
    // `.context`); undefined for transport errors or a successful result.
    const httpStatus = (r: { error: unknown }): number | undefined => {
        const ctx = (r.error as { context?: unknown } | null)?.context;
        return ctx instanceof Response ? ctx.status : undefined;
    };

    let result = await invoke();

    // Silent retry once on FunctionsFetchError ONLY — that's the
    // transport-layer fetch rejection (network blip, DNS hiccup,
    // Supabase Edge Runtime cold-start exceeding the socket timeout),
    // not a real HTTP response. Most resolve on the second attempt and
    // the user never sees an error. (5xx HTTP errors get their OWN retry
    // just below; 4xx is never retried — the 401 stale-session sign-out
    // must run exactly once.)
    //
    // ~700ms back-off: long enough to cover most cellular blips and give
    // the proxy a moment to warm up after a cold-start socket timeout,
    // short enough to read as "slight loading lag" rather than "broken."
    if (
        result.error &&
        (result.error as Error).name === 'FunctionsFetchError'
    ) {
        console.warn(
            '[tmdb-proxy] FunctionsFetchError on first attempt, retrying once after back-off:',
            result.error.message,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        result = await invoke();
    }

    // Retry on upstream 5xx — TMDB intermittently returns HTTP 500
    // (status_code 11, "Internal error: Something went wrong, contact
    // TMDb.") on detail / append_to_response=credits calls. These are
    // transient upstream flakes that almost always succeed on a retry, so
    // recover them silently before the user sees an error. Up to 2 retries
    // with a short escalating back-off (300ms, 600ms). 4xx is NEVER retried
    // here — those are conscious responses (auth, bad request), and the 401
    // stale-session sign-out below must fire exactly once.
    const MAX_5XX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_5XX_RETRIES; attempt++) {
        const status = httpStatus(result);
        if (status === undefined || status < 500 || status > 599) break;
        console.warn(
            `[tmdb-proxy] upstream ${status} (attempt ${attempt}/${MAX_5XX_RETRIES}) — retrying after back-off`,
        );
        await new Promise<void>((resolve) =>
            setTimeout(resolve, 300 * attempt),
        );
        result = await invoke();
        if (!result.error) break;
    }

    const { data, error } = result;

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
        // Log the raw upstream body for diagnostics ONLY — it must never go
        // into the thrown message (it used to render verbatim as a wall of
        // JSON on the title/rec screens). Cap the log so a huge cast list
        // doesn't flood the console.
        if (detail) {
            console.warn(
                `[tmdb-proxy] ${status ?? '?'} error body:`,
                detail.slice(0, 500),
            );
        }
        // Short, body-free message — callers map this to friendly UI copy.
        throw new Error(
            status ? `tmdb-proxy ${status}` : `tmdb-proxy: ${error.message}`,
        );
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
    return callProxy('search/multi', { query, page, include_adult: false });
}

export function searchMovies(
    query: string,
    page = 1,
): Promise<TMDBSearchResult<TMDBMovieSummary>> {
    return callProxy('search/movie', { query, page, include_adult: false });
}

export function searchTV(
    query: string,
    page = 1,
): Promise<TMDBSearchResult<TMDBTVSummary>> {
    return callProxy('search/tv', { query, page, include_adult: false });
}

// `appendCredits`/`appendVideos` add TMDB's `append_to_response` params so the
// detail response carries the cast and/or trailer list inline — one request
// instead of follow-up /credits and /videos calls. Both default false to keep
// the payload small on callers that don't render them (the ensureTitle
// forward-path stamps title metadata only). The tmdb-proxy allowlist matches on
// path only, so the appended query params flow through without any proxy
// migration.
function appendParam(options?: {
    appendCredits?: boolean;
    appendVideos?: boolean;
}): Record<string, string> {
    const parts = [
        ...(options?.appendCredits ? ['credits'] : []),
        ...(options?.appendVideos ? ['videos'] : []),
    ];
    return parts.length > 0 ? { append_to_response: parts.join(',') } : {};
}

export function getMovie(
    tmdbId: number,
    options?: { appendCredits?: boolean; appendVideos?: boolean },
): Promise<TMDBMovie> {
    return callProxy(`movie/${tmdbId}`, appendParam(options));
}

export function getTV(
    tmdbId: number,
    options?: { appendCredits?: boolean; appendVideos?: boolean },
): Promise<TMDBTV> {
    return callProxy(`tv/${tmdbId}`, appendParam(options));
}

// A single TV season's episode list. Backed by the tv/{id}/season/{n} proxy
// allowlist entry (added 2026-07-13); the episode-list screen renders these
// and each episode opens an episode-scoped chat.
export function getTVSeason(
    tmdbId: number,
    seasonNumber: number,
): Promise<TMDBSeasonDetail> {
    return callProxy(`tv/${tmdbId}/season/${seasonNumber}`);
}

// Pick the single best trailer to surface on the title screen, or null if
// none qualifies (→ the caller renders nothing). YouTube only (that's all we
// deep-link to); Trailer/Teaser only. Rank: official Trailer > Trailer >
// official Teaser > Teaser. Within a rank, prefer an English video (fall back
// to any language), then the most recently published. Pure selection — no I/O.
export function selectTrailerKey(
    videos: TMDBVideo[] | undefined,
): string | null {
    const candidates = (videos ?? []).filter(
        (v) =>
            v.site === 'YouTube' &&
            !!v.key &&
            (v.type === 'Trailer' || v.type === 'Teaser'),
    );
    if (candidates.length === 0) return null;

    const rank = (v: TMDBVideo): number => {
        if (v.type === 'Trailer') return v.official ? 0 : 1;
        return v.official ? 2 : 3; // Teaser
    };

    const best = [...candidates].sort((a, b) => {
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        // English preferred within rank, then newest first.
        const byLang =
            (a.iso_639_1 === 'en' ? 0 : 1) - (b.iso_639_1 === 'en' ? 0 : 1);
        if (byLang !== 0) return byLang;
        return (b.published_at ?? '').localeCompare(a.published_at ?? '');
    });

    return best[0].key;
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

// ---------------------------------------------------------------------------
// List endpoints — feed the onboarding poster grid's blend (trending /
// popular / top_rated / discover-by-genre). Thin passthroughs like the search
// wrappers above, so callProxy's transient-5xx retry applies automatically.
// Each is single-media-type (caller passes 'movie' | 'tv'); the blend screen
// tags media_type per source from the call site, since popular/top_rated/
// discover responses don't carry it. Proxy paths were added to the allowlist
// in tmdb-proxy (deliberate, exact paths) — see that function.
// ---------------------------------------------------------------------------

// Trending this week. (Week window only — that's what the allowlist permits.)
export function getTrending(
    media: 'movie' | 'tv',
    page = 1,
): Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>> {
    return callProxy(`trending/${media}/week`, { page });
}

export function getPopular(
    media: 'movie' | 'tv',
    page = 1,
): Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>> {
    return callProxy(`${media}/popular`, { page });
}

export function getTopRated(
    media: 'movie' | 'tv',
    page = 1,
): Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>> {
    return callProxy(`${media}/top_rated`, { page });
}

// `genreIds` are TMDB genre ids; PIPE-joined = OR-match ("any of these"). TMDB
// treats a COMMA as AND (title must match ALL genres), which collapses the
// result set to almost nothing — so we MUST use `|` here. with_genres + page +
// include_adult + any `extraParams` (sort_by, with_original_language,
// vote_count.gte) ride as forwarded query params — the proxy allowlist matches
// the PATH only and passes every body param through to TMDB, so no proxy change
// is needed to add discover filters.
export function discoverByGenre(
    media: 'movie' | 'tv',
    genreIds: number[],
    page = 1,
    extraParams: ProxyParams = {},
): Promise<TMDBSearchResult<TMDBMovieSummary | TMDBTVSummary>> {
    return callProxy(`discover/${media}`, {
        with_genres: genreIds.join('|'),
        page,
        include_adult: false,
        ...extraParams,
    });
}
