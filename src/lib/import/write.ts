/**
 * The write phase of the library import. Runs ONLY after the user
 * confirms the preview.
 *
 * Safety properties, by construction:
 *   - Skip-existing: rows already in the library are filtered before
 *     writing AND the insert itself is ON CONFLICT DO NOTHING
 *     (ignoreDuplicates), so a re-run of the same file — or a race
 *     with the user adding titles mid-import — never overwrites a row.
 *   - Fail closed per row: a chunk that errors falls back to per-row
 *     inserts, so one bad row fails alone instead of poisoning its
 *     chunk; failures are reported, never partially written.
 *   - Normal RLS: plain authenticated inserts as the signed-in user —
 *     no service role, no elevated path.
 */
import supabase from '@/lib/supabase';
import { ensureTitle, fetchTitlesByItems } from '@/lib/titles';

import {
    chosenCandidate,
    type Candidate,
    type ImportOutcome,
    type PreviewRow,
} from './types';

const INSERT_CHUNK = 50;
const STAMP_CONCURRENCY = 4;

export function itemKey(c: { tmdbId: number; mediaType: string }): string {
    return `${c.mediaType}:${c.tmdbId}`;
}

/**
 * Every (media_type, tmdb_id) key already in the user's library.
 * Paginated because supabase caps a single select at 1000 rows and a
 * post-import library is well past that.
 */
export async function fetchExistingKeys(userId: string): Promise<Set<string>> {
    const keys = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
            .from('items')
            .select('tmdb_id, media_type')
            .eq('user_id', userId)
            .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const row of data ?? []) {
            keys.add(`${row.media_type}:${row.tmdb_id}`);
        }
        if (!data || data.length < PAGE) break;
    }
    return keys;
}

interface ItemInsert {
    user_id: string;
    tmdb_id: number;
    media_type: string;
    status: string;
    rating: number | null;
    watched_at: string | null;
}

function insertRowFor(
    userId: string,
    row: PreviewRow,
    candidate: Candidate,
): ItemInsert {
    const watched = row.parsed.status === 'watched';
    return {
        user_id: userId,
        tmdb_id: candidate.tmdbId,
        media_type: candidate.mediaType,
        status: row.parsed.status,
        // The DB check constraint allows a rating only on watched rows;
        // parsers already guarantee this, enforced again here so a
        // future parser bug degrades to a null rating, not a failed row.
        rating: watched ? row.parsed.rating : null,
        watched_at: watched ? row.parsed.watchedAt : null,
    };
}

/**
 * Write the confirmed preview. `onProgress(written, total)` tracks item
 * writes (the title-catalogue stamping afterwards is best-effort and
 * not part of the progress denominator).
 */
export async function runImport(
    userId: string,
    rows: PreviewRow[],
    onProgress?: (done: number, total: number) => void,
): Promise<ImportOutcome> {
    let skipped = 0;
    let excluded = 0;
    const failed: PreviewRow[] = [];

    // Partition the preview: what gets written vs why not.
    const toWrite: Array<{ row: PreviewRow; candidate: Candidate }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const candidate = chosenCandidate(row);
        if (row.excluded) {
            excluded++;
            continue;
        }
        if (!candidate) {
            // Unresolved needs-attention rows the user chose to leave —
            // counted as excluded in the done state.
            excluded++;
            continue;
        }
        if (row.inLibrary) {
            skipped++;
            continue;
        }
        const key = itemKey(candidate);
        if (seen.has(key)) {
            // Two export rows resolved to the same title (e.g. a fix
            // pointed at an already-matched film) — first one wins.
            skipped++;
            continue;
        }
        seen.add(key);
        toWrite.push({ row, candidate });
    }

    let imported = 0;
    let done = 0;
    const writtenCandidates: Candidate[] = [];

    for (let i = 0; i < toWrite.length; i += INSERT_CHUNK) {
        const chunk = toWrite.slice(i, i + INSERT_CHUNK);
        const inserts = chunk.map(({ row, candidate }) =>
            insertRowFor(userId, row, candidate),
        );
        // ignoreDuplicates → ON CONFLICT DO NOTHING on the
        // (user_id, tmdb_id, media_type) unique constraint. select()
        // returns only the rows actually inserted, so conflict-skips
        // are counted precisely.
        const { data, error } = await supabase
            .from('items')
            .upsert(inserts, {
                onConflict: 'user_id,tmdb_id,media_type',
                ignoreDuplicates: true,
            })
            .select('tmdb_id, media_type');
        if (error) {
            // Chunk failed — isolate per row so one bad row doesn't
            // take 49 good ones down with it.
            for (const entry of chunk) {
                const { error: rowError } = await supabase
                    .from('items')
                    .upsert(insertRowFor(userId, entry.row, entry.candidate), {
                        onConflict: 'user_id,tmdb_id,media_type',
                        ignoreDuplicates: true,
                    });
                if (rowError) {
                    console.warn(
                        `import write failed for "${entry.row.parsed.name}":`,
                        rowError,
                    );
                    failed.push(entry.row);
                } else {
                    imported++;
                    writtenCandidates.push(entry.candidate);
                }
                done++;
                onProgress?.(done, toWrite.length);
            }
            continue;
        }
        const insertedKeys = new Set(
            (data ?? []).map((r) => `${r.media_type}:${r.tmdb_id}`),
        );
        for (const entry of chunk) {
            if (insertedKeys.has(itemKey(entry.candidate))) {
                imported++;
                writtenCandidates.push(entry.candidate);
            } else {
                skipped++; // conflicted mid-flight — already owned
            }
        }
        done += chunk.length;
        onProgress?.(done, toWrite.length);
    }

    // Stamp the shared titles catalogue so the library renders posters
    // and metadata immediately (the library reads public.titles, not
    // TMDB). Only titles missing a catalogue row are stamped; failures
    // are non-blocking (ensureTitle swallows its own errors) — a missed
    // stamp backfills on the next add by any user.
    try {
        const existing = await fetchTitlesByItems(
            writtenCandidates.map((c) => ({
                tmdb_id: c.tmdbId,
                media_type: c.mediaType,
            })),
        );
        const missing = writtenCandidates.filter(
            (c) => !existing.has(`${c.mediaType}:${c.tmdbId}`),
        );
        let next = 0;
        await Promise.all(
            Array.from(
                { length: Math.min(STAMP_CONCURRENCY, missing.length) },
                async () => {
                    while (next < missing.length) {
                        const c = missing[next++];
                        await ensureTitle({
                            tmdbId: c.tmdbId,
                            mediaType: c.mediaType,
                            title: c.title,
                            posterPath: c.posterPath,
                            backdropPath: c.backdropPath,
                            releaseDate: c.releaseDate,
                            originalLanguage: c.originalLanguage,
                            genreIds: c.genreIds,
                        });
                    }
                },
            ),
        );
    } catch (err) {
        console.warn('import title stamping failed (non-blocking):', err);
    }

    return { imported, skipped, excluded, failed };
}
