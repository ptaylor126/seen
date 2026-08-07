/**
 * Shared types for the library import feature (Settings → Import your
 * library). Stage 2 covers Letterboxd + IMDb; `ImportSource` and the
 * registry in ./registry.ts are the seam where TV Time (stage 3) plugs
 * in — add the enum member and a SourceDefinition, nothing else changes.
 */
import type { MediaType } from '@/lib/rating';

// 'tvtime' joins in stage 3 (blocked on a real sample export).
export type ImportSource = 'letterboxd' | 'imdb';

// The picked document, already read into memory. `bytes` not text —
// the Letterboxd path may be a ZIP. Lives here (not registry.ts) so
// parsers depend only on types.ts and the registry→parser import
// stays one-directional (a registry↔parser require cycle broke
// expo-router's route scan).
export interface PickedFile {
    name: string;
    bytes: Uint8Array;
}

// Thrown by parsers for user-facing failures (wrong file, empty
// export). The run screen shows `.message` verbatim — keep messages
// written for the user, not the console.
export class ImportParseError extends Error {}

// Imports only produce these two states — no source exports a
// meaningful "currently watching" signal at show level.
export type ImportStatus = 'watched' | 'watchlist';

// One row parsed out of the source export, normalised to app semantics
// before resolution: rating already on the items 1–10 half-star scale,
// dates already ISO.
export interface ParsedRow {
    // Stable within one import run — used as the React key and the
    // dedupe handle. `${source}:${index}` from the parser.
    key: string;
    name: string;
    year: number | null;
    status: ImportStatus;
    // items.rating scale (1–10), or null when the source row carries no
    // rating. Parsers normalise: Letterboxd 0.5–5 doubles, IMDb 1–10
    // maps as-is. Only meaningful when status === 'watched' (the DB
    // check constraint rejects rated watchlist rows).
    rating: number | null;
    watchedAt: string | null; // ISO timestamp or null
    // Exact-id resolution path (IMDb `Const`, e.g. "tt0111161").
    // Null → resolve by name+year TMDB search.
    imdbId: string | null;
    // What the source says this is. IMDb's Title Type maps
    // tvSeries/tvMiniSeries → 'tv', movie-likes → 'movie'; null means
    // the source doesn't say (Letterboxd mixes films and TV in one
    // catalogue) and resolution searches BOTH media via /search/multi.
    // Also picks between /find's movie_results and tv_results.
    mediaTypeHint: MediaType | null;
}

export interface ParseResult {
    rows: ParsedRow[];
    // Rows the source contains but the app can't represent (e.g. IMDb
    // tvEpisode ratings — we track show-level only). Counted so the
    // preview can say what was left out rather than silently dropping.
    unsupported: number;
}

// A TMDB title a parsed row may resolve to. Carries everything
// `ensureTitle` needs so the import can stamp the shared catalogue
// without a second TMDB round-trip.
export interface Candidate {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    year: number | null;
    posterPath: string | null;
    backdropPath: string | null;
    releaseDate: string | null; // 'YYYY-MM-DD' or null
    originalLanguage: string;
    genreIds: number[];
}

// Resolution outcome per row. 'matched' keeps the full candidate list
// so the preview's correction sheet can still offer alternatives — an
// exact name+year match can be the WRONG film (the ~7 mis-resolutions
// in the original 760-film import), so every row stays fixable.
export type Resolution =
    | { kind: 'matched'; candidate: Candidate; candidates: Candidate[] }
    | { kind: 'ambiguous'; candidates: Candidate[]; chosen: Candidate | null }
    | { kind: 'unmatched' }
    | { kind: 'failed' }; // TMDB call errored — fail closed, row importable only after retry/fix

// One row of the pre-import preview. No DB writes happen while these
// exist — the import runs only on explicit confirm, over the rows that
// have a chosen candidate, aren't excluded, and aren't already owned.
export interface PreviewRow {
    parsed: ParsedRow;
    resolution: Resolution;
    // True when the user's library already has (tmdb_id, media_type).
    // These are never written (skip-existing, no overwrites).
    inLibrary: boolean;
    // User toggled this row out of the import.
    excluded: boolean;
}

// The candidate this row would import as, or null (unmatched / failed /
// ambiguous-without-choice).
export function chosenCandidate(row: PreviewRow): Candidate | null {
    if (row.resolution.kind === 'matched') return row.resolution.candidate;
    if (row.resolution.kind === 'ambiguous') return row.resolution.chosen;
    return null;
}

export interface ImportOutcome {
    imported: number;
    // Pre-known "already in library" rows + duplicate rows within the
    // file + insert-time conflict skips (idempotent by construction).
    skipped: number;
    excluded: number;
    // Rows whose write errored (fail closed per row — no partial write).
    failed: PreviewRow[];
}
