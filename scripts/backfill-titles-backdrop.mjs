#!/usr/bin/env node
/**
 * One-shot backfill of titles.backdrop_path for rows that don't have it.
 *
 * Migration 20260616120000 added the column nullable; this script fills
 * the existing rows by re-fetching each title's TMDB detail and
 * UPDATE-ing backdrop_path. Re-runnable: each run queries
 * `WHERE backdrop_path IS NULL` so a previous run's failures (or rows
 * inserted since) get picked up.
 *
 * Three outcomes per row:
 *   - updated:             TMDB returned a backdrop, UPDATE succeeded.
 *   - no_backdrop_on_tmdb: TMDB has no backdrop for this title (NULL
 *                          is the correct value); UPDATE writes NULL
 *                          and the row STAYS in the "missing" set on
 *                          the next run. Expected ~5-15% per the
 *                          earlier image-data audit (~95% mainstream
 *                          movies have one, ~85% TV, lower indie).
 *   - failed:              TMDB 404 / 429 / 5xx / network — re-run to
 *                          retry.
 *
 * Note that "stays in the missing set on re-run" for the
 * no_backdrop_on_tmdb case is acceptable for the alpha: re-fetching
 * those rows costs one TMDB round-trip per re-run but doesn't corrupt
 * anything. If those re-fetches become a problem later, a separate
 * "tried, found no backdrop" sentinel column would let us skip them
 * permanently — overkill today.
 *
 * Skips tmdb-proxy and uses TMDB directly for the same reason as
 * scripts/backfill-titles.mjs — the proxy authenticates per-user JWT,
 * awkward for unattended work. Allowlist semantics preserved locally
 * (mediaType gated to 'movie' | 'tv', tmdb_id from a Postgres integer
 * column).
 *
 * Run (env supplied at invocation):
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   TMDB_ACCESS_TOKEN=... \
 *     node scripts/backfill-titles-backdrop.mjs
 */
import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENV = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TMDB_ACCESS_TOKEN',
];
for (const name of REQUIRED_ENV) {
    if (!process.env[name]) {
        console.error(`error: missing required env var ${name}`);
        process.exit(2);
    }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN;

const TMDB_BASE = 'https://api.themoviedb.org/3';
const PAGE_SIZE = 1000;
const CONCURRENCY = 8;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// Load every titles row that doesn't have a backdrop yet. Pages
// defensively in case the corpus grows past 1000 — today it's ~842
// so one page is enough, but the loop costs nothing.
async function loadMissing() {
    const missing = [];
    let from = 0;
    for (;;) {
        const { data, error } = await supabase
            .from('titles')
            .select('tmdb_id, media_type')
            .is('backdrop_path', null)
            .order('tmdb_id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`titles select failed: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const row of data) {
            if (row.media_type !== 'movie' && row.media_type !== 'tv') {
                console.warn(
                    `skipping titles row with unknown media_type: ${row.media_type}`,
                );
                continue;
            }
            missing.push({ mediaType: row.media_type, tmdbId: row.tmdb_id });
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return missing;
}

// Fetch one title's detail. Returns the backdrop_path string OR null
// (TMDB doesn't have one for this title). Throws on network/HTTP
// failure — the worker catches and counts as failed.
async function fetchBackdrop(mediaType, tmdbId) {
    if (mediaType !== 'movie' && mediaType !== 'tv') {
        throw new Error(`invalid media_type: ${mediaType}`);
    }
    const url = `${TMDB_BASE}/${mediaType}/${tmdbId}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${TMDB_TOKEN}`,
            Accept: 'application/json',
        },
    });
    if (!res.ok) {
        throw new Error(`tmdb ${res.status} ${mediaType}:${tmdbId}`);
    }
    const data = await res.json();
    return typeof data.backdrop_path === 'string' ? data.backdrop_path : null;
}

async function processAll(missing) {
    const counters = {
        processed: 0,
        updated: 0,
        no_backdrop_on_tmdb: 0,
        failed: 0,
    };
    const queue = missing.slice();
    const startedAt = Date.now();
    let nextLog = 0;

    async function worker() {
        for (;;) {
            const job = queue.shift();
            if (!job) return;
            counters.processed += 1;
            let backdrop;
            try {
                backdrop = await fetchBackdrop(job.mediaType, job.tmdbId);
            } catch (err) {
                console.warn(
                    `fetch failed ${job.mediaType}:${job.tmdbId}: ${err.message}`,
                );
                counters.failed += 1;
                continue;
            }
            const { error } = await supabase
                .from('titles')
                .update({ backdrop_path: backdrop })
                .eq('tmdb_id', job.tmdbId)
                .eq('media_type', job.mediaType);
            if (error) {
                console.warn(
                    `update failed ${job.mediaType}:${job.tmdbId}: ${error.message}`,
                );
                counters.failed += 1;
                continue;
            }
            if (backdrop) {
                counters.updated += 1;
            } else {
                counters.no_backdrop_on_tmdb += 1;
            }
            if (counters.processed >= nextLog) {
                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
                console.log(
                    `  progress: ${counters.processed}/${missing.length} (${elapsed}s, ${counters.updated} updated, ${counters.no_backdrop_on_tmdb} no-backdrop, ${counters.failed} failed)`,
                );
                nextLog = counters.processed + 50;
            }
        }
    }

    await Promise.all(
        Array.from({ length: CONCURRENCY }, () => worker()),
    );
    return counters;
}

async function main() {
    console.log('loading titles missing backdrop_path…');
    const missing = await loadMissing();
    console.log(`${missing.length} titles missing backdrop`);
    if (missing.length === 0) {
        console.log('nothing to backfill — done.');
        return;
    }
    const counters = await processAll(missing);
    console.log('---');
    console.log(`processed:              ${counters.processed}`);
    console.log(`updated (got backdrop): ${counters.updated}`);
    console.log(`no backdrop on TMDB:    ${counters.no_backdrop_on_tmdb}`);
    console.log(`failed:                 ${counters.failed} (re-run to retry)`);
}

main().catch((err) => {
    console.error('backfill aborted:', err);
    process.exit(1);
});
