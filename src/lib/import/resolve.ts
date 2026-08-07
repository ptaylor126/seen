/**
 * Resolution: parsed export rows → TMDB titles.
 *
 * Two paths:
 *   - IMDb rows carry a tt-id → exact lookup via /find (no fuzziness).
 *   - Letterboxd rows resolve by name+year search with a conservative
 *     auto-match rule; anything less than confident lands in the
 *     preview's needs-attention group for the user to fix.
 *
 * All TMDB traffic runs through a small concurrency pool — the proxy
 * has 504'd under burst load before, so a 700-row import must trickle,
 * not firehose. Read-only: nothing here writes to the database.
 */
import type { MediaType } from '@/lib/rating';
import {
    findByImdbId,
    searchMovies,
    searchMulti,
    searchTV,
    type TMDBMovieSummary,
    type TMDBTVSummary,
} from '@/lib/tmdb';

import type { Candidate, ParsedRow, Resolution } from './types';

// Gentle on the proxy: 4 in flight, ~700 rows complete in well under a
// minute while staying far from the burst shapes that produced 504s.
const RESOLVE_CONCURRENCY = 4;
// How many search results the correction sheet offers.
const MAX_CANDIDATES = 6;

function yearFrom(date: string | null | undefined): number | null {
    if (!date || date.length < 4) return null;
    const y = Number.parseInt(date.slice(0, 4), 10);
    return Number.isFinite(y) ? y : null;
}

function movieCandidate(m: TMDBMovieSummary): Candidate {
    return {
        tmdbId: m.id,
        mediaType: 'movie',
        title: m.title,
        year: yearFrom(m.release_date),
        posterPath: m.poster_path,
        backdropPath: m.backdrop_path,
        releaseDate: m.release_date && m.release_date.length > 0 ? m.release_date : null,
        originalLanguage: m.original_language,
        genreIds: m.genre_ids ?? [],
    };
}

function tvCandidate(t: TMDBTVSummary): Candidate {
    return {
        tmdbId: t.id,
        mediaType: 'tv',
        title: t.name,
        year: yearFrom(t.first_air_date),
        posterPath: t.poster_path,
        backdropPath: t.backdrop_path,
        releaseDate:
            t.first_air_date && t.first_air_date.length > 0
                ? t.first_air_date
                : null,
        originalLanguage: t.original_language,
        genreIds: t.genre_ids ?? [],
    };
}

// Fold case, diacritics and punctuation so "Amélie" matches "Amelie"
// and "WALL·E" matches "WALL-E". Whitespace collapses.
function normalizeTitle(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function resolveByImdbId(
    imdbId: string,
    hint: MediaType | null,
): Promise<Resolution> {
    const found = await findByImdbId(imdbId);
    const movies = (found.movie_results ?? []).map(movieCandidate);
    const tv = (found.tv_results ?? []).map(tvCandidate);
    // An exact external id maps to at most one title per media bucket.
    // Prefer the bucket the export said it was; a populated other
    // bucket wins over an empty preferred one (TMDB knows best what
    // the tt-id actually is).
    const preferred = hint === 'tv' ? [tv, movies] : [movies, tv];
    for (const bucket of preferred) {
        if (bucket.length > 0) {
            return {
                kind: 'matched',
                candidate: bucket[0],
                candidates: [...movies, ...tv].slice(0, MAX_CANDIDATES),
            };
        }
    }
    return { kind: 'unmatched' };
}

// One search, hint-directed. A null hint means the source's catalogue
// mixes films and TV (Letterboxd), so we use /search/multi: ONE proxy
// call returns both media, letting a TV entry (Squid Game, The Queen's
// Gambit) resolve at all, and — because the auto-match predicate then
// runs over the COMBINED exact-title set — a movie and a show sharing
// title+year land as two exact-year candidates and stay ambiguous
// (labelled Movie / TV in the sheet) instead of the movie silently
// shadowing the show. A media-specific hint keeps the scoped search:
// IMDb name-fallbacks know their Title Type, TV Time (stage 3) is
// TV-only.
async function searchCandidates(row: ParsedRow): Promise<Candidate[]> {
    if (row.mediaTypeHint === 'movie') {
        return (await searchMovies(row.name)).results.map(movieCandidate);
    }
    if (row.mediaTypeHint === 'tv') {
        return (await searchTV(row.name)).results.map(tvCandidate);
    }
    const multi = await searchMulti(row.name);
    return multi.results.flatMap((r) => {
        if (r.media_type === 'movie') return [movieCandidate(r)];
        if (r.media_type === 'tv') return [tvCandidate(r)];
        return []; // person results
    });
}

async function resolveByNameYear(row: ParsedRow): Promise<Resolution> {
    const all = await searchCandidates(row);
    if (all.length === 0) return { kind: 'unmatched' };

    const wanted = normalizeTitle(row.name);
    const exactTitle = all.filter((c) => normalizeTitle(c.title) === wanted);

    // Candidate list for the sheet: exact-title hits first (closest
    // year first), then the rest in TMDB's relevance order.
    const rest = all.filter((c) => !exactTitle.includes(c));
    const byYearCloseness = (a: Candidate, b: Candidate) => {
        if (row.year === null) return 0;
        const da = a.year === null ? 99 : Math.abs(a.year - row.year);
        const db = b.year === null ? 99 : Math.abs(b.year - row.year);
        return da - db;
    };
    const candidates = [...exactTitle].sort(byYearCloseness).concat(rest)
        .slice(0, MAX_CANDIDATES);

    // Auto-match rule. An exact-year + exact-title hit that is UNIQUE
    // wins outright — other same-title candidates in nearby years are
    // search noise (shorts, remakes, foreign films), not ambiguity.
    // The first cut required a unique candidate across the whole ±1
    // window, which sent obvious titles (Whiplash 2014, next to its
    // 2013 short) to needs-attention — 83 of 772 rows on a real
    // export, nearly all resolving to the top candidate on tap.
    //
    // What stays ambiguous (the genuine traps from the original
    // import's ~7 silent mis-resolves):
    //   - two+ exact title+year candidates (same name, same year);
    //   - no exact-year hit and two+ same-title candidates adjacent
    //     to the source year (an off-by-one source year can't say
    //     which of them it meant).
    if (row.year !== null) {
        const exactYear = exactTitle.filter((c) => c.year === row.year);
        if (exactYear.length === 1) {
            return { kind: 'matched', candidate: exactYear[0], candidates };
        }
        if (exactYear.length === 0) {
            // Exact year missed (regional release-date offsets): a
            // unique same-title candidate one year off is still safe.
            const nearYear = exactTitle.filter(
                (c) => c.year !== null && Math.abs(c.year - row.year!) <= 1,
            );
            if (nearYear.length === 1) {
                return {
                    kind: 'matched',
                    candidate: nearYear[0],
                    candidates,
                };
            }
        }
    } else if (exactTitle.length === 1) {
        // No year in the export: a unique exact-title hit is still safe.
        return { kind: 'matched', candidate: exactTitle[0], candidates };
    }

    return { kind: 'ambiguous', candidates, chosen: null };
}

export async function resolveRow(row: ParsedRow): Promise<Resolution> {
    try {
        if (row.imdbId) {
            return await resolveByImdbId(row.imdbId, row.mediaTypeHint);
        }
        return await resolveByNameYear(row);
    } catch (err) {
        console.warn(`import resolve failed for "${row.name}":`, err);
        return { kind: 'failed' };
    }
}

/**
 * Resolve all rows through the concurrency pool. Results align with the
 * input by index. `onProgress(done, total)` fires after each row;
 * `shouldStop()` lets the screen abandon the run on unmount — remaining
 * rows come back 'failed', but callers that stop discard the result.
 */
export async function resolveRows(
    rows: ParsedRow[],
    opts: {
        onProgress?: (done: number, total: number) => void;
        shouldStop?: () => boolean;
    } = {},
): Promise<Resolution[]> {
    const results: Resolution[] = rows.map(() => ({ kind: 'failed' }));
    let next = 0;
    let done = 0;

    async function worker(): Promise<void> {
        while (true) {
            if (opts.shouldStop?.()) return;
            const i = next++;
            if (i >= rows.length) return;
            results[i] = await resolveRow(rows[i]);
            done++;
            opts.onProgress?.(done, rows.length);
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(RESOLVE_CONCURRENCY, rows.length) },
            () => worker(),
        ),
    );
    return results;
}
