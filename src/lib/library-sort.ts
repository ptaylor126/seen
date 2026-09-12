import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

// The six sort options offered across library-shaped screens (own Library
// tab + friend library) — see SORT_OPTIONS_BY_TAB / SORT_LABELS in
// use-library-filters.ts for how a tab narrows this full set down and how
// each option is labelled. Defined here, the persistence leaf, rather than
// there, to avoid a circular import; use-library-filters.ts re-exports the
// type so its existing consumers are unaffected.
export type SortOption =
    | 'dateWatched'
    | 'dateAdded'
    | 'rating'
    | 'title'
    | 'releaseNewest'
    | 'releaseOldest';

const ALL_SORT_OPTIONS: readonly SortOption[] = [
    'dateWatched',
    'dateAdded',
    'rating',
    'title',
    'releaseNewest',
    'releaseOldest',
];

const STORAGE_KEY = 'seen.library.sort_by';
// Matches DEFAULT_SORT_BY_TAB.watchlist in use-library-filters.ts — the
// same fallback the pre-persistence useState seeded on every cold start.
const DEFAULT_SORT_BY: SortOption = 'dateAdded';

function isValid(value: unknown): value is SortOption {
    return (
        typeof value === 'string' &&
        (ALL_SORT_OPTIONS as readonly string[]).includes(value)
    );
}

// ---- Module-singleton store — same shape as library-view.ts's, for the
// same reason: sortBy is ONE global value shared by every useLibraryFilters
// consumer (own Library tab + friend library, exactly like the view-mode
// preference already is), so a change on one screen must be visible on the
// other without a remount. AsyncStorage is the persistence layer only;
// `current` is the runtime source of truth. Stored as a plain string
// rather than JSON (unlike view_mode's object) since a SortOption already
// IS the string AsyncStorage reads back — no parse step needed.
let current: SortOption = DEFAULT_SORT_BY;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// Must return a referentially STABLE value between renders when nothing
// has changed (useSyncExternalStore compares snapshots by identity) —
// `current` is a string primitive, so equality IS identity here.
function getSnapshot(): SortOption {
    return current;
}

function setSortByStore(next: SortOption): void {
    if (next === current) return; // no change — skip the notify + write.
    current = next;
    emit();
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
        // Write failure is silent — the in-memory value is authoritative
        // for the session; the next change retries.
    });
}

// Hydrate the persisted value exactly once per app session, no matter how
// many consumers mount. A stored value that's no longer a recognised
// SortOption (e.g. an option removed in a later release) is treated as
// absent — falls back to DEFAULT_SORT_BY rather than crashing or wedging
// the UI on a dead value.
let hydrated = false;
function hydrateOnce(): void {
    if (hydrated) return;
    hydrated = true;
    AsyncStorage.getItem(STORAGE_KEY)
        .then((raw) => {
            if (raw == null) return;
            if (isValid(raw) && raw !== current) {
                current = raw;
                emit();
            }
        })
        .catch(() => {
            // Read failure — stay on the default already in `current`.
        });
}

export function useLibrarySortStore() {
    const sortBy = useSyncExternalStore(subscribe, getSnapshot);
    useEffect(() => {
        hydrateOnce();
    }, []);

    const setSortBy = useCallback((next: SortOption) => {
        setSortByStore(next);
    }, []);

    return { sortBy, setSortBy };
}
