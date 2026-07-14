/**
 * Forward-path stamping into the shared `public.titles` catalogue.
 *
 * Every items-insert site (title-detail status change, the onboarding
 * steps via setOnboardingItemStatus) calls
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
import { getMovie, getTV } from '@/lib/tmdb';

// Row shape returned by `fetchTitlesByItems`. Mirrors the columns we
// select from public.titles. Nullable everywhere the column is
// nullable on the DB so the consumer can branch on missing data.
export interface TitleRow {
    tmdb_id: number;
    media_type: MediaType;
    title: string | null;
    poster_path: string | null;
    // TMDB landscape image path. Null when TMDB doesn't have one for
    // this title (~5-15% of titles per the 2026-06-16 audit — niche,
    // festival, unreleased entries). Renderer consumers handle null
    // with a fallback (solid surfaceAlt with title overlaid).
    backdrop_path: string | null;
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
            'tmdb_id, media_type, title, poster_path, backdrop_path, release_date, original_language, genre_ids',
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
            backdrop_path: row.backdrop_path,
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
    backdropPath: string | null;
    releaseDate: string | null;  // 'YYYY-MM-DD' or null. Caller maps TMDB empty-string to null.
    originalLanguage: string;
    genreIds: number[];
}

export async function ensureTitle(args: EnsureTitleArgs): Promise<void> {
    // Argument names changed from snake_case-matching-columns to p_*
    // in 20260616130000 — see that migration's header for the
    // #variable_conflict use_variable history and why the rename was
    // necessary to safely add DO UPDATE SET. PostgREST resolves the
    // RPC by named-argument set, so passing the OLD names would now
    // fail with PGRST202.
    const { error } = await supabase.rpc('ensure_title', {
        p_tmdb_id: args.tmdbId,
        p_media_type: args.mediaType,
        p_title: args.title,
        // The generated Database['public']['Functions']['ensure_title']
        // signature types these as required `string`, but the
        // underlying Postgres function args are `text`/`date`, which
        // accept NULL. supabase-js will serialise a null JS value to
        // JSON null and the RPC accepts it. Cast at this boundary so
        // call sites can pass null naturally for unknown poster/
        // backdrop/date.
        // reason: typegen marks nullable text args as required-string.
        p_poster_path: args.posterPath as unknown as string,
        p_backdrop_path: args.backdropPath as unknown as string,
        p_release_date: args.releaseDate as unknown as string,
        p_original_language: args.originalLanguage,
        p_genre_ids: args.genreIds,
    });
    if (error) {
        console.warn('ensure_title failed (non-blocking):', error);
    }
}

// Fetch poster/title metadata for a set of (tmdb_id, media_type) from the
// shared catalogue, filling any missing rows via a direct TMDB fetch (and
// stamping them forward with ensureTitle) — so a rec'd / reviewed / chatted-
// about title that was never added to anyone's library still renders. Batched:
// one catalogue read + one TMDB call per missing title, never N catalogue
// calls. Returns the populated key→row map (keyed `${media_type}:${tmdb_id}`).
// Lifted out of friends/[handle].tsx so the recs-between, recent-reviews and
// chats sections share ONE implementation.
export async function fetchTitlesWithFallback(
    items: { tmdb_id: number; media_type: string }[],
): Promise<Map<string, TitleRow>> {
    const titleByKey = await fetchTitlesByItems(items);
    const missing = new Map<string, { tmdbId: number; mediaType: MediaType }>();
    for (const it of items) {
        const key = `${it.media_type}:${it.tmdb_id}`;
        if (titleByKey.has(key)) continue;
        if (it.media_type !== 'movie' && it.media_type !== 'tv') continue;
        missing.set(key, { tmdbId: it.tmdb_id, mediaType: it.media_type });
    }
    if (missing.size === 0) return titleByKey;
    const fetched = await Promise.all(
        Array.from(missing.values()).map(
            async (m): Promise<EnsureTitleArgs | null> => {
                try {
                    if (m.mediaType === 'movie') {
                        const mv = await getMovie(m.tmdbId);
                        return {
                            tmdbId: m.tmdbId,
                            mediaType: 'movie',
                            title: mv.title,
                            posterPath: mv.poster_path,
                            backdropPath: mv.backdrop_path,
                            releaseDate:
                                mv.release_date && mv.release_date.length > 0
                                    ? mv.release_date
                                    : null,
                            originalLanguage: mv.original_language,
                            genreIds: mv.genres.map((g) => g.id),
                        };
                    }
                    const tv = await getTV(m.tmdbId);
                    return {
                        tmdbId: m.tmdbId,
                        mediaType: 'tv',
                        title: tv.name,
                        posterPath: tv.poster_path,
                        backdropPath: tv.backdrop_path,
                        releaseDate:
                            tv.first_air_date && tv.first_air_date.length > 0
                                ? tv.first_air_date
                                : null,
                        originalLanguage: tv.original_language,
                        genreIds: tv.genres.map((g) => g.id),
                    };
                } catch (err) {
                    console.warn('title TMDB fallback failed:', err);
                    return null;
                }
            },
        ),
    );
    for (const s of fetched) {
        if (!s) continue;
        titleByKey.set(`${s.mediaType}:${s.tmdbId}`, {
            tmdb_id: s.tmdbId,
            media_type: s.mediaType,
            title: s.title,
            poster_path: s.posterPath,
            backdrop_path: s.backdropPath,
            release_date: s.releaseDate,
            original_language: s.originalLanguage,
            genre_ids: s.genreIds,
        });
        void ensureTitle(s);
    }
    return titleByKey;
}
