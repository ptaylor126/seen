/**
 * IMDb ratings export parser (ratings.csv from imdb.com → Your
 * Ratings → "Actions" ⋮ menu → Export; prepared asynchronously —
 * minutes, even for small libraries — and downloaded from
 * imdb.com/exports when it shows "Ready". Watchlist is a separate
 * export from its own page with the same column shape; both files
 * run through this parser, one import each).
 *
 * Columns used: Const (tt-id — the exact-resolution handle), Title,
 * Year, Your Rating (already 1–10, maps to items.rating as-is), Date
 * Rated (→ watched_at), Title Type (→ movie/tv mapping).
 *
 * Title Type mapping: movie-like types → 'movie'; tvSeries +
 * tvMiniSeries → 'tv'; tvEpisode is counted as unsupported (the app
 * tracks shows, not episodes) rather than silently dropped.
 *
 * Blank "Your Rating" is a supported case, not an error: the row
 * imports as WATCHLIST (no rating, no watched_at) — an unrated row
 * carries no evidence of watching. A rated row imports as watched.
 * This per-row rule is what makes IMDb LIST exports absorb
 * gracefully — they carry the same Const/Your Rating columns with
 * ratings mostly blank — while ratings.csv (where every row is
 * rated by definition) stays the documented path and imports
 * all-watched as before. We deliberately do NOT try to classify a
 * list file as watchlist-vs-watched; the rating is the only
 * per-row signal used, and rows stay excludable in the preview.
 */
import { strFromU8 } from 'fflate';

import { csvObjects, parseCsv } from './csv';
import {
    ImportParseError,
    type ParsedRow,
    type ParseResult,
    type PickedFile,
} from './types';
import type { MediaType } from '@/lib/rating';

const MOVIE_TYPES = new Set([
    'movie',
    'tvmovie',
    'tvspecial',
    'short',
    'tvshort',
    'video',
]);
const TV_TYPES = new Set(['tvseries', 'tvminiseries']);

function mediaTypeFor(titleType: string): MediaType | 'unsupported' {
    // IMDb has shipped both spellings over the years: camelCase
    // ("tvSeries", "tvEpisode") and spaced ("TV Series", "TV Episode").
    // Fold to bare lowercase alphanumerics so both forms classify.
    const t = titleType.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (TV_TYPES.has(t)) return 'tv';
    if (t === 'tvepisode') return 'unsupported';
    // Everything else (including unknown future types) is closest to a
    // film — and the tt-id /find resolution corrects us if TMDB says
    // it's actually TV.
    if (MOVIE_TYPES.has(t) || t.length > 0) return 'movie';
    return 'movie';
}

export function parseImdb(file: PickedFile): ParseResult {
    const table = parseCsv(strFromU8(file.bytes));
    const cols = table.header.map((h) => h.trim().toLowerCase());
    if (!cols.includes('const') || !cols.includes('your rating')) {
        throw new ImportParseError(
            "That CSV doesn't look like an IMDb export. It needs the Const and Your Rating columns. Export from IMDb → Your Ratings → Actions → Export, then download it from imdb.com/exports when it shows Ready.",
        );
    }

    const rows: ParsedRow[] = [];
    let unsupported = 0;
    for (const row of csvObjects(table)) {
        const imdbId = row['const']?.trim() ?? '';
        const name = row['title']?.trim() ?? '';
        if (!/^tt\d+$/.test(imdbId) || !name) continue;

        const media = mediaTypeFor(row['title type'] ?? '');
        if (media === 'unsupported') {
            unsupported++;
            continue;
        }

        // Blank or malformed rating → null, row kept. The rating is
        // the watched signal: rated → watched; unrated → watchlist
        // (see file header re list exports). watched_at only ever
        // accompanies watched.
        const ratingNum = Number.parseInt(row['your rating'] ?? '', 10);
        const rating =
            Number.isFinite(ratingNum) && ratingNum >= 1 && ratingNum <= 10
                ? ratingNum
                : null;
        const watched = rating !== null;

        const yearNum = Number.parseInt(row['year'] ?? '', 10);
        const dateRated = (row['date rated'] ?? '').trim();
        const watchedAt =
            watched && /^\d{4}-\d{2}-\d{2}$/.test(dateRated)
                ? `${dateRated}T12:00:00.000Z`
                : null;

        rows.push({
            key: `imdb:${rows.length}`,
            name,
            year: Number.isFinite(yearNum) ? yearNum : null,
            status: watched ? 'watched' : 'watchlist',
            rating,
            watchedAt,
            imdbId,
            mediaTypeHint: media,
        });
    }
    if (rows.length === 0) {
        throw new ImportParseError('No importable titles found in that file.');
    }
    return { rows, unsupported };
}
