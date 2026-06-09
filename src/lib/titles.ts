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
