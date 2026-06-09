#!/usr/bin/env node
/**
 * One-shot backfill of public.titles from TMDB.
 *
 * For every distinct (tmdb_id, media_type) pair currently referenced
 * by public.items, ensure a row exists in public.titles with the
 * denormalised TMDB metadata (title, poster_path, release_date,
 * original_language, genre_ids). One TMDB fetch per unique title
 * regardless of how many users have it in their library.
 *
 * Re-runnable. The driver query computes "missing" as
 * (distinct items pairs) MINUS (existing titles pairs), so a second
 * run only processes whatever the previous run failed on (TMDB 404,
 * 429, transient 5xx, network) or whatever items rows were inserted
 * between runs.
 *
 * Credentials: read from process.env, never hardcoded, never written
 * to disk by this script.
 *   - SUPABASE_URL                — project REST endpoint
 *   - SUPABASE_SERVICE_ROLE_KEY   — RLS-bypass for inserting titles
 *                                   (the table has no client INSERT
 *                                   policy by design) and for reading
 *                                   items across all users
 *   - TMDB_ACCESS_TOKEN           — v4 read access token (Bearer)
 *
 * Skips the tmdb-proxy Edge Function deliberately: the proxy
 * authenticates per-user JWT, which is awkward for an unattended
 * backfill. Allowlist semantics are preserved locally — only
 * `movie/{id}` and `tv/{id}` URLs are ever built, with `mediaType`
 * gated to 'movie' | 'tv' and `tmdbId` coming from a Postgres
 * `integer` column.
 *
 * Run (you supply env at invocation time — script reads only):
 *   SUPABASE_URL=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… \
 *   TMDB_ACCESS_TOKEN=… \
 *     node scripts/backfill-titles.mjs
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
const PAGE_SIZE = 1000;  // Supabase REST default cap per request.
const CONCURRENCY = 8;   // ~30 req/sec at 250 ms/call — under TMDB's ~40/s.

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Step 1: enumerate (tmdb_id, media_type) pairs across all items, then
// subtract the pairs that already have a titles row. The PostgREST API
// has no DISTINCT — we walk items in pages and dedupe client-side. items
// is small (~hundreds to low thousands of rows) so this is cheap.
// ---------------------------------------------------------------------------

async function loadAllItemsPairs() {
    const seen = new Set();
    let from = 0;
    for (;;) {
        const { data, error } = await supabase
            .from('items')
            .select('tmdb_id, media_type')
            .order('tmdb_id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`items select failed: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const row of data) {
            if (row.media_type !== 'movie' && row.media_type !== 'tv') {
                console.warn(
                    `skipping items row with unknown media_type: ${row.media_type}`,
                );
                continue;
            }
            seen.add(`${row.media_type}:${row.tmdb_id}`);
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return [...seen].map((key) => {
        const colon = key.indexOf(':');
        return {
            mediaType: key.slice(0, colon),
            tmdbId: Number(key.slice(colon + 1)),
        };
    });
}

async function loadExistingTitlesPairs() {
    const seen = new Set();
    let from = 0;
    for (;;) {
        const { data, error } = await supabase
            .from('titles')
            .select('tmdb_id, media_type')
            .order('tmdb_id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`titles select failed: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const row of data) {
            seen.add(`${row.media_type}:${row.tmdb_id}`);
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return seen;
}

// ---------------------------------------------------------------------------
// Step 2: fetch one (mediaType, tmdbId) from TMDB. Returns the insert
// payload on success, null on any non-2xx (logged with status). Never
// throws — the runner counts nulls as "failed, continue".
// ---------------------------------------------------------------------------

async function fetchTitle(mediaType, tmdbId) {
    if (mediaType !== 'movie' && mediaType !== 'tv') {
        console.warn(`skipping ${mediaType}:${tmdbId} — unknown media_type`);
        return null;
    }
    const url = `${TMDB_BASE}/${mediaType}/${tmdbId}`;
    let res;
    try {
        res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${TMDB_TOKEN}`,
                Accept: 'application/json',
            },
        });
    } catch (err) {
        console.warn(`fetch error ${mediaType}:${tmdbId}: ${err.message}`);
        return null;
    }
    if (!res.ok) {
        console.warn(`tmdb ${res.status} ${mediaType}:${tmdbId}`);
        return null;
    }
    const data = await res.json();
    const rawDate =
        mediaType === 'movie' ? data.release_date : data.first_air_date;
    const releaseDate =
        typeof rawDate === 'string' && rawDate.length > 0 ? rawDate : null;
    const genreIds = Array.isArray(data.genres)
        ? data.genres
              .map((g) => (typeof g?.id === 'number' ? g.id : null))
              .filter((id) => id !== null)
        : [];
    const titleText = mediaType === 'movie' ? data.title : data.name;
    return {
        tmdb_id: tmdbId,
        media_type: mediaType,
        title: typeof titleText === 'string' ? titleText : null,
        poster_path:
            typeof data.poster_path === 'string' ? data.poster_path : null,
        release_date: releaseDate,
        original_language:
            typeof data.original_language === 'string'
                ? data.original_language
                : null,
        genre_ids: genreIds,
    };
}

// ---------------------------------------------------------------------------
// Step 3: bounded-concurrency runner. Eight workers pull from the queue;
// each task is one (fetch + insert) cycle for one unique title. The
// insert uses on_conflict=do_nothing semantics (via upsert with
// ignoreDuplicates) so a parallel run or a row inserted between
// "subtract existing" and "insert" doesn't trip a unique-violation.
// ---------------------------------------------------------------------------

async function processAll(missing) {
    const counters = { processed: 0, inserted: 0, failed: 0 };
    const queue = missing.slice();
    const startedAt = Date.now();
    let nextLog = 0;

    async function worker() {
        for (;;) {
            const job = queue.shift();
            if (!job) return;
            const payload = await fetchTitle(job.mediaType, job.tmdbId);
            counters.processed += 1;
            if (!payload) {
                counters.failed += 1;
            } else {
                const { error } = await supabase
                    .from('titles')
                    .upsert(payload, {
                        onConflict: 'tmdb_id,media_type',
                        ignoreDuplicates: true,
                    });
                if (error) {
                    console.warn(
                        `insert failed ${job.mediaType}:${job.tmdbId}: ${error.message}`,
                    );
                    counters.failed += 1;
                } else {
                    counters.inserted += 1;
                }
            }
            if (counters.processed >= nextLog) {
                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
                console.log(
                    `  progress: ${counters.processed}/${missing.length} titles (${elapsed}s elapsed, ${counters.inserted} inserted, ${counters.failed} failed)`,
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    console.log('loading items pairs…');
    const itemsPairs = await loadAllItemsPairs();
    console.log(`found ${itemsPairs.length} distinct (tmdb_id, media_type) pairs in items`);

    console.log('loading existing titles pairs…');
    const existing = await loadExistingTitlesPairs();
    console.log(`found ${existing.size} existing titles rows`);

    const missing = itemsPairs.filter(
        (p) => !existing.has(`${p.mediaType}:${p.tmdbId}`),
    );
    console.log(`${missing.length} titles to fetch`);
    if (missing.length === 0) {
        console.log('nothing to backfill — done.');
        return;
    }

    const counters = await processAll(missing);

    console.log('---');
    console.log(`titles processed: ${counters.processed}`);
    console.log(`titles inserted:  ${counters.inserted}`);
    console.log(`titles failed:    ${counters.failed} (re-run to retry)`);
}

main().catch((err) => {
    console.error('backfill aborted:', err);
    process.exit(1);
});
