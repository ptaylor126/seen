/**
 * Forward-path stamping into the shared `public.titles` catalogue.
 *
 * Every items-insert site (title-detail status change, onboarding
 * currently-watching pick, onboarding best-watched pick) calls
 * `ensureTitle` after its items upsert succeeds. The RPC does
 * INSERT ... ON CONFLICT DO NOTHING server-side, so:
 *   - First-time titles get stamped into the catalogue as the user
 *     adds them, no waiting for a backfill re-run.
 *   - Existing rows (from the backfill, or a prior user's add) are
 *     never overwritten with potentially staler client-side metadata.
 *
 * Failure is intentionally swallowed (logged only). The items insert
 * is the user's actual intent — a missed catalogue stamp just means
 * that title's metadata fills in on the next add (any user) or the
 * next backfill. Surfacing this as a blocking error would mean a
 * transient network blip prevents adding a film to the library, which
 * is worse than a row that's temporarily missing its catalogue entry
 * (the library render falls back gracefully for missing titles rows).
 */
import supabase from '@/lib/supabase';
import type { MediaType } from '@/lib/rating';

// Row shape returned by `fetchTitlesByItems`. Mirrors the columns we
// select from public.titles. Nullable everywhere the column is
// nullable on the DB so the consumer can branch on missing data.
export interface TitleRow {
    tmdb_id: number;
    media_type: MediaType;
    title: string | null;
    poster_path: string | null;
    release_date: string | null;  // 'YYYY-MM-DD' or null.
    original_language: string | null;
    genre_ids: number[] | null;
}

/**
 * Batch-fetch shared catalogue rows for a set of items. One round-trip
 * regardless of input size; the returned Map is keyed by
 * `${media_type}:${tmdb_id}` so callers can look up per item.
 *
 * Replaces the per-item TMDB metadata fetches (`getMovie` / `getTV`)
 * previously used by the library, friend-library, and home screens.
 *
 * Missing key → `Map.get(...) === undefined`; the caller renders its
 * own existing fallback (e.g. "Unable to load title" placeholder, or
 * skip-the-card depending on screen). After stage 2's 842-row
 * backfill + stage 3's forward-path stamping, missing keys should be
 * rare (forward-stamp failure is the only producer going forward).
 *
 * `.in('tmdb_id', …)` is the only column-level filter — we then key
 * the response Map by (media_type, tmdb_id) so a `tmdb_id` that
 * happens to exist for BOTH a movie and a TV row (TMDB's id spaces
 * don't collide in practice, but defensively cheap) resolves
 * independently.
 */
export async function fetchTitlesByItems(
    items: ReadonlyArray<{ tmdb_id: number; media_type: string }>,
): Promise<Map<string, TitleRow>> {
    const byKey = new Map<string, TitleRow>();
    if (items.length === 0) return byKey;
    const tmdbIds = Array.from(new Set(items.map((i) => i.tmdb_id)));
    const { data, error } = await supabase
        .from('titles')
        .select(
            'tmdb_id, media_type, title, poster_path, release_date, original_language, genre_ids',
        )
        .in('tmdb_id', tmdbIds);
    if (error) throw error;
    for (const row of data ?? []) {
        if (row.media_type !== 'movie' && row.media_type !== 'tv') continue;
        byKey.set(`${row.media_type}:${row.tmdb_id}`, {
            tmdb_id: row.tmdb_id,
            media_type: row.media_type,
            title: row.title,
            poster_path: row.poster_path,
            release_date: row.release_date,
            original_language: row.original_language,
            genre_ids: row.genre_ids,
        });
    }
    return byKey;
}

export interface EnsureTitleArgs {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    posterPath: string | null;
    releaseDate: string | null;  // 'YYYY-MM-DD' or null. Caller maps TMDB empty-string to null.
    originalLanguage: string;
    genreIds: number[];
}

export async function ensureTitle(args: EnsureTitleArgs): Promise<void> {
    const { error } = await supabase.rpc('ensure_title', {
        tmdb_id: args.tmdbId,
        media_type: args.mediaType,
        title: args.title,
        // The generated Database['public']['Functions']['ensure_title']
        // signature types these as required `string`, but the
        // underlying Postgres function args are `text`/`date`, which
        // accept NULL. supabase-js will serialise a null JS value to
        // JSON null and the RPC accepts it. Cast at this boundary so
        // call sites can pass null naturally for unknown poster/date.
        // reason: typegen marks nullable text args as required-string.
        poster_path: args.posterPath as unknown as string,
        release_date: args.releaseDate as unknown as string,
        original_language: args.originalLanguage,
        genre_ids: args.genreIds,
    });
    if (error) {
        console.warn('ensure_title failed (non-blocking):', error);
    }
}
