/**
 * Shared filter / sort / search state for library-shaped screens.
 *
 * Used by the own-library tab (src/app/(tabs)/library.tsx) and the
 * friend-library route (src/app/friends/[handle].tsx). Both screens
 * load their own rows (different RLS scopes, different queries), but
 * the in-memory filter / sort / search logic is identical post-stage-4
 * since both row types satisfy FilterableLibraryRow.
 *
 * The hook owns:
 *   - localQuery (title substring search, client-side)
 *   - mediaFilter ('all' | 'movie' | 'tv', client-side)
 *   - sortBy (dateWatched | dateAdded | rating, client-side comparator
 *     with explicit NULLS-LAST per field — re-implements the SQL
 *     `ORDER BY … NULLS LAST` the loader used to use server-side)
 *   - genreFilter (number | null, client-side `.includes` on genreIds)
 *   - genreStripOpen (controls the genre chip strip visibility)
 *
 * Derived:
 *   - visibleRows: ALWAYS runs the sort comparator, even when sortBy
 *     is at its tab default. The raw loader order (typically
 *     updated_at DESC for ingestion stability) must never leak
 *     through; the displayed order is what the user picked via sortBy.
 *   - availableGenres: distinct genre_ids from the LOADED rows (not
 *     visibleRows — the picker should show every genre present in the
 *     loaded set so the user can move between filters without first
 *     clearing the current one), mapped via TMDB_GENRE_NAMES, sorted
 *     alphabetically.
 *
 * Side effects:
 *   - Invalid-sort clear: when the active tab doesn't offer the
 *     current sortBy (e.g. swap Watched → Watchlist while sorted by
 *     Rating; Watchlist only offers Date added), snap to the new
 *     tab's default. A valid sort is preserved across compatible
 *     tabs (e.g. Date watched stays selected when swapping Watching
 *     ↔ Watched).
 *   - Stale-genre clear: drop genreFilter to null if the active id
 *     leaves the visible-genre set (e.g. media filter narrows rows).
 */

import { useEffect, useMemo, useState } from 'react';

import { TMDB_GENRE_NAMES } from '@/lib/genres';
import type { MediaType } from '@/lib/rating';

export type ItemStatus = 'watchlist' | 'watching' | 'watched';
export type MediaFilter = 'all' | 'movie' | 'tv';
export type SortOption = 'dateWatched' | 'dateAdded' | 'rating';

// Minimal row shape the hook needs. Screen-specific row types
// (LibraryRow with recAttribution, ItemRow without) extend this via
// structural typing — the hook is generic in T so each screen gets
// back its own full row type, not a narrowed view.
export interface FilterableLibraryRow {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    rating: number | null;
    watchedAt: string | null;
    createdAt: string;
    genreIds: number[] | null;
}

// Constants used by both the hook and the shared controls component.
// Exported here so the component reads from one source.
export const MEDIA_FILTERS: readonly MediaFilter[] = [
    'all',
    'movie',
    'tv',
] as const;

export const MEDIA_FILTER_LABELS: Record<MediaFilter, string> = {
    all: 'All',
    movie: 'Movies',
    tv: 'TV',
};

export const SORT_LABELS: Record<SortOption, string> = {
    dateWatched: 'Date watched',
    dateAdded: 'Date added',
    rating: 'Rating',
};

// Per-tab sort default — Watchlist / Watching emphasise when added,
// Watched emphasises when seen. Used when the current sortBy is
// invalid for a newly-active tab (see the invalid-sort clear effect
// below).
export const DEFAULT_SORT_BY_TAB: Record<ItemStatus, SortOption> = {
    watchlist: 'dateAdded',
    watching: 'dateAdded',
    watched: 'dateWatched',
};

// Per-tab sort options. Watchlist items are unwatched and typically
// unrated, so "Date watched" and "Rating" sort nothing meaningful
// there — offer only "Date added". Watching and Watched both support
// the full set. Order matters: it's the order the sort picker lists
// options to the user.
//
// Invariant: DEFAULT_SORT_BY_TAB[tab] must be a member of
// SORT_OPTIONS_BY_TAB[tab] for every tab. (Verified by inspection;
// adding a tab here without updating the default would surface as a
// silent default-snap to an off-list option.)
export const SORT_OPTIONS_BY_TAB: Record<ItemStatus, readonly SortOption[]> = {
    watchlist: ['dateAdded'],
    watching: ['dateWatched', 'dateAdded', 'rating'],
    watched: ['dateWatched', 'dateAdded', 'rating'],
};

export interface UseLibraryFiltersResult<T extends FilterableLibraryRow> {
    visibleRows: T[];
    availableGenres: Array<{ id: number; name: string }>;
    // Sort options offered to the user for the active tab. The picker
    // lists exactly these; tabs that only have one meaningful sort
    // (Watchlist → Date added only) still get a single-entry array.
    availableSortOptions: readonly SortOption[];
    localQuery: string;
    setLocalQuery: (q: string) => void;
    mediaFilter: MediaFilter;
    setMediaFilter: (f: MediaFilter) => void;
    sortBy: SortOption;
    setSortBy: (s: SortOption) => void;
    genreFilter: number | null;
    setGenreFilter: (id: number | null) => void;
    genreStripOpen: boolean;
    setGenreStripOpen: (open: boolean) => void;
}

// DESC comparator with NULLS-LAST semantics. ISO-8601 timestamp
// strings sort lexicographically the same way they sort
// chronologically, so the `<` / `>` path works for both string keys
// (watchedAt / createdAt) and the numeric rating key without branching.
function compareDescNullsLast<T extends FilterableLibraryRow>(
    a: T,
    b: T,
    key: 'watchedAt' | 'createdAt' | 'rating',
): number {
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av < bv) return 1;
    if (av > bv) return -1;
    return 0;
}

const SORT_KEY: Record<SortOption, 'watchedAt' | 'createdAt' | 'rating'> = {
    dateWatched: 'watchedAt',
    dateAdded: 'createdAt',
    rating: 'rating',
};

export function useLibraryFilters<T extends FilterableLibraryRow>(
    rows: T[],
    activeTab: ItemStatus,
): UseLibraryFiltersResult<T> {
    const [localQuery, setLocalQuery] = useState('');
    const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
    const [sortBy, setSortBy] = useState<SortOption>(
        DEFAULT_SORT_BY_TAB.watchlist,
    );
    const [genreFilter, setGenreFilter] = useState<number | null>(null);
    const [genreStripOpen, setGenreStripOpen] = useState(false);

    const availableSortOptions = SORT_OPTIONS_BY_TAB[activeTab];

    // Snap sort to the new tab's default ONLY if the current sortBy
    // isn't valid for that tab. Preserving a valid sort across
    // compatible tabs (e.g. Date watched stays selected when swapping
    // Watching ↔ Watched) is the UX improvement that falls out of
    // making the option set tab-specific — the previous "always
    // reset" was a workaround for the absent gating. The dependency
    // on sortBy is intentional: if the user picks something invalid
    // for the current tab (shouldn't happen via the picker now, but
    // belt-and-braces), this effect snaps them back.
    useEffect(() => {
        if (!availableSortOptions.includes(sortBy)) {
            setSortBy(DEFAULT_SORT_BY_TAB[activeTab]);
        }
    }, [activeTab, sortBy, availableSortOptions]);

    // visibleRows composes title search + media filter + genre filter,
    // then ALWAYS applies the sort comparator. The raw input order
    // (whatever the loader handed us, typically updated_at DESC for
    // ingestion stability) must never leak through to the rendered
    // list — the displayed order is the sort the user picked, period.
    const visibleRows = useMemo(() => {
        const q = localQuery.trim().toLowerCase();
        const filtered = rows.filter((r) => {
            if (q && !r.title.toLowerCase().includes(q)) return false;
            if (mediaFilter !== 'all' && r.mediaType !== mediaFilter) {
                return false;
            }
            if (genreFilter !== null) {
                if (!r.genreIds || !r.genreIds.includes(genreFilter)) {
                    return false;
                }
            }
            return true;
        });
        // `.filter` already returned a new array, but the explicit
        // `.slice()` keeps this safe if a future refactor returns a
        // reference into `rows` — Array.sort is in-place.
        const sortKey = SORT_KEY[sortBy];
        return filtered
            .slice()
            .sort((a, b) => compareDescNullsLast(a, b, sortKey));
    }, [rows, localQuery, mediaFilter, sortBy, genreFilter]);

    // availableGenres derives from the LOADED rows (not visibleRows).
    // The picker should show every genre present in the loaded set so
    // the user can move between filters without first clearing the
    // current one — otherwise filtering by Comedy would hide every
    // other genre from the picker. Map.get falls back to `#${id}` so
    // an unmapped TMDB id (rare but possible if TMDB adds a new
    // genre) still renders without crashing.
    const availableGenres = useMemo(() => {
        const ids = new Set<number>();
        for (const row of rows) {
            if (row.genreIds) {
                for (const id of row.genreIds) ids.add(id);
            }
        }
        return Array.from(ids)
            .map((id) => ({
                id,
                name: TMDB_GENRE_NAMES.get(id) ?? `#${id}`,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [rows]);

    // Drop a stale genre selection when the loaded rows no longer
    // contain it — e.g. media filter changes and the previously-active
    // genre is no longer in any visible row. Without this the UI
    // strands the user on "No {genre} titles" with no obvious exit.
    useEffect(() => {
        if (genreFilter === null) return;
        const stillPresent = availableGenres.some(
            (g) => g.id === genreFilter,
        );
        if (!stillPresent) setGenreFilter(null);
    }, [availableGenres, genreFilter]);

    return {
        visibleRows,
        availableGenres,
        availableSortOptions,
        localQuery,
        setLocalQuery,
        mediaFilter,
        setMediaFilter,
        sortBy,
        setSortBy,
        genreFilter,
        setGenreFilter,
        genreStripOpen,
        setGenreStripOpen,
    };
}
