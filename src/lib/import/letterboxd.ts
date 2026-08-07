/**
 * Letterboxd export parser.
 *
 * Accepts EITHER the full export ZIP (letterboxd.com → Settings → Data →
 * Export) or one of its CSVs picked individually. The ZIP contains
 * watched.csv / ratings.csv / watchlist.csv / diary.csv (plus files we
 * ignore); all four are merged into one row set keyed by (Name, Year):
 *
 *   - watched.csv   → status 'watched', watchedAt from its Date column
 *   - diary.csv     → better watchedAt (the actual "Watched Date"; the
 *                     latest entry wins), per-entry rating as fallback
 *   - ratings.csv   → the CURRENT rating (authoritative — overrides any
 *                     diary-entry rating), 0.5–5 doubled to items 1–10
 *   - watchlist.csv → status 'watchlist' (unless already watched)
 *
 * Letterboxd's catalogue is mostly films but DOES contain TV entries
 * (Squid Game, The Queen's Gambit), and the export doesn't say which
 * is which — so every row gets mediaTypeHint null ("unknown, search
 * both media") and resolves by name+year via /search/multi. No
 * exact-id column exists.
 */
import { strFromU8, unzipSync } from 'fflate';

import { csvObjects, parseCsv } from './csv';
import {
    ImportParseError,
    type ParsedRow,
    type ParseResult,
    type PickedFile,
} from './types';

type LetterboxdKind = 'watched' | 'ratings' | 'watchlist' | 'diary';

interface Accumulated {
    name: string;
    year: number | null;
    status: 'watched' | 'watchlist';
    rating: number | null;
    ratingAuthoritative: boolean; // true once ratings.csv has spoken
    watchedAt: string | null;
    watchedAtFromDiary: boolean;
}

function isZip(file: PickedFile): boolean {
    const b = file.bytes;
    return (
        b.length >= 4 &&
        b[0] === 0x50 && // P
        b[1] === 0x4b && // K
        b[2] === 0x03 &&
        b[3] === 0x04
    );
}

// 'YYYY-MM-DD' → ISO at noon UTC. Noon (not midnight) so the calendar
// day survives rendering in any timezone the user's device is in.
function isoFromDate(date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
    return `${date.trim()}T12:00:00.000Z`;
}

// Letterboxd rating '0.5'–'5' in half-star steps → items 1–10.
function itemsRating(raw: string): number | null {
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) return null;
    const doubled = Math.round(v * 2);
    return Math.min(10, Math.max(1, doubled));
}

function classify(basename: string, header: string[]): LetterboxdKind | null {
    const name = basename.toLowerCase();
    if (name.includes('watchlist')) return 'watchlist';
    if (name.includes('diary')) return 'diary';
    if (name.includes('ratings')) return 'ratings';
    if (name.includes('watched')) return 'watched';
    // Filename didn't tell — sniff the header. Diary and ratings have
    // distinctive columns; watched vs watchlist share an identical
    // header (Date,Name,Year,Letterboxd URI) so an unrecognised
    // filename with that shape is genuinely ambiguous → null.
    const cols = header.map((h) => h.trim().toLowerCase());
    if (cols.includes('watched date')) return 'diary';
    if (cols.includes('rating')) return 'ratings';
    return null;
}

function mergeFile(
    kind: LetterboxdKind,
    text: string,
    byKey: Map<string, Accumulated>,
): void {
    const table = parseCsv(text);
    const cols = table.header.map((h) => h.trim().toLowerCase());
    if (!cols.includes('name') || !cols.includes('year')) {
        throw new ImportParseError(
            "That CSV doesn't look like a Letterboxd export. It has no Name/Year columns.",
        );
    }
    for (const row of csvObjects(table)) {
        const name = row['name']?.trim();
        if (!name) continue;
        const yearNum = Number.parseInt(row['year'] ?? '', 10);
        const year = Number.isFinite(yearNum) ? yearNum : null;
        const key = `${name.toLowerCase()}|${year ?? ''}`;

        let acc = byKey.get(key);
        if (!acc) {
            acc = {
                name,
                year,
                status: 'watchlist',
                rating: null,
                ratingAuthoritative: false,
                watchedAt: null,
                watchedAtFromDiary: false,
            };
            byKey.set(key, acc);
        }

        switch (kind) {
            case 'watched': {
                acc.status = 'watched';
                if (!acc.watchedAtFromDiary) {
                    acc.watchedAt =
                        isoFromDate(row['date'] ?? '') ?? acc.watchedAt;
                }
                break;
            }
            case 'diary': {
                acc.status = 'watched';
                const watched = isoFromDate(row['watched date'] ?? '');
                // Latest diary entry wins (rewatches).
                if (
                    watched &&
                    (!acc.watchedAtFromDiary ||
                        acc.watchedAt === null ||
                        watched > acc.watchedAt)
                ) {
                    acc.watchedAt = watched;
                    acc.watchedAtFromDiary = true;
                }
                if (!acc.ratingAuthoritative) {
                    acc.rating = itemsRating(row['rating'] ?? '') ?? acc.rating;
                }
                break;
            }
            case 'ratings': {
                // A rating implies watched even when watched.csv is absent
                // (single-file ratings.csv import).
                acc.status = 'watched';
                const rating = itemsRating(row['rating'] ?? '');
                if (rating !== null) {
                    acc.rating = rating;
                    acc.ratingAuthoritative = true;
                }
                if (acc.watchedAt === null) {
                    acc.watchedAt = isoFromDate(row['date'] ?? '');
                }
                break;
            }
            case 'watchlist': {
                // Watched wins — a title can sit on the watchlist for a
                // rewatch, but our model has one status per title.
                if (acc.status !== 'watched') acc.status = 'watchlist';
                break;
            }
        }
    }
}

export function parseLetterboxd(file: PickedFile): ParseResult {
    const byKey = new Map<string, Accumulated>();

    if (isZip(file)) {
        let entries: Record<string, Uint8Array>;
        try {
            entries = unzipSync(file.bytes);
        } catch {
            throw new ImportParseError(
                "Couldn't read that ZIP file. Try re-downloading your Letterboxd export.",
            );
        }
        // Merge order matters: watched establishes the base, diary
        // refines watchedAt, ratings is authoritative for rating,
        // watchlist last (never demotes watched).
        const order: LetterboxdKind[] = [
            'watched',
            'diary',
            'ratings',
            'watchlist',
        ];
        const found: Partial<Record<LetterboxdKind, string>> = {};
        for (const [path, bytes] of Object.entries(entries)) {
            if (!path.toLowerCase().endsWith('.csv')) continue;
            const basename = path.split('/').pop() ?? path;
            // Exact-name match only inside the ZIP — the export also
            // contains e.g. reviews.csv, comments.csv, lists/*.csv which
            // must not be swept in by substring matching.
            const kind = (
                ['watched', 'ratings', 'watchlist', 'diary'] as const
            ).find((k) => basename.toLowerCase() === `${k}.csv`);
            if (kind) found[kind] = strFromU8(bytes);
        }
        if (Object.keys(found).length === 0) {
            throw new ImportParseError(
                "That ZIP doesn't contain a Letterboxd export (no watched.csv, ratings.csv or watchlist.csv inside).",
            );
        }
        for (const kind of order) {
            const text = found[kind];
            if (text) mergeFile(kind, text, byKey);
        }
    } else {
        const text = strFromU8(file.bytes);
        const table = parseCsv(text);
        const kind = classify(file.name, table.header);
        if (!kind) {
            throw new ImportParseError(
                "Couldn't tell which Letterboxd file this is. Use the original filename (watched.csv, ratings.csv, watchlist.csv or diary.csv), or import the whole export ZIP.",
            );
        }
        mergeFile(kind, text, byKey);
    }

    const rows: ParsedRow[] = Array.from(byKey.values()).map((acc, i) => ({
        key: `letterboxd:${i}`,
        name: acc.name,
        year: acc.year,
        status: acc.status,
        rating: acc.status === 'watched' ? acc.rating : null,
        watchedAt: acc.status === 'watched' ? acc.watchedAt : null,
        imdbId: null,
        mediaTypeHint: null,
    }));
    if (rows.length === 0) {
        throw new ImportParseError('No films found in that file.');
    }
    return { rows, unsupported: 0 };
}
