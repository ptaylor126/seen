import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type LibraryMode = 'list' | 'grid';
export type LibraryGridCols = 2 | 3 | 4;

export interface LibraryView {
    mode: LibraryMode;
    gridCols: LibraryGridCols;
}

const STORAGE_KEY = 'seen.library.view_mode';
const DEFAULT_VIEW: LibraryView = { mode: 'list', gridCols: 3 };

function isValid(value: unknown): value is LibraryView {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        (v.mode === 'list' || v.mode === 'grid') &&
        (v.gridCols === 2 || v.gridCols === 3 || v.gridCols === 4)
    );
}

// ---- Module-singleton store: ONE source of truth for the library view,
// shared by every consumer in the session.
//
// The previous shape was write-through to a shared AsyncStorage key but
// read-once into each hook's PRIVATE useState — so changing density on the
// friend library never reached the own Library tab (or vice versa) until a
// cold launch re-mounted the other screen and re-read the key. A value with
// one storage location but multiple private copies isn't single-sourced; it
// just looks like it until someone changes one.
//
// Now: `current` is the single live value; `useLibraryView` subscribes via
// useSyncExternalStore, so any setMode/setGridCols notifies every mounted
// consumer immediately. AsyncStorage is the persistence layer only, not the
// runtime source of truth. A Context provider would also work but needs root
// wiring and buys nothing here — the module store is the smaller drop-in
// (the hook's public signature is unchanged, so no call site changes).
let current: LibraryView = DEFAULT_VIEW;
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

// Must return a referentially STABLE value between renders when nothing has
// changed (useSyncExternalStore compares snapshots by identity) — `current`
// only gets a new object reference inside setView / hydrateOnce.
function getSnapshot(): LibraryView {
    return current;
}

function setView(next: LibraryView): void {
    if (next.mode === current.mode && next.gridCols === current.gridCols) {
        return; // no change — skip the notify + the redundant write.
    }
    current = next;
    emit();
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {
        // Write failure is silent — the in-memory value is authoritative for
        // the session; the next change retries.
    });
}

// Hydrate the persisted value exactly once per app session, no matter how
// many consumers mount. Publishes to every subscriber if the stored value
// differs from the default we started on.
let hydrated = false;
function hydrateOnce(): void {
    if (hydrated) return;
    hydrated = true;
    AsyncStorage.getItem(STORAGE_KEY)
        .then((raw) => {
            if (raw == null) return;
            try {
                const parsed: unknown = JSON.parse(raw);
                if (
                    isValid(parsed) &&
                    (parsed.mode !== current.mode ||
                        parsed.gridCols !== current.gridCols)
                ) {
                    current = parsed;
                    emit();
                }
            } catch {
                // Corrupt entry — stay on defaults already in `current`.
            }
        })
        .catch(() => {
            // Read failure — stay on defaults.
        });
}

export function useLibraryView() {
    const view = useSyncExternalStore(subscribe, getSnapshot);
    useEffect(() => {
        hydrateOnce();
    }, []);

    // setMode/setGridCols read the live `current` (not a render-time closure),
    // so they always compose against the latest value — no stale ref needed.
    const setMode = useCallback((mode: LibraryMode) => {
        setView({ ...current, mode });
    }, []);

    const setGridCols = useCallback((gridCols: LibraryGridCols) => {
        setView({ ...current, gridCols });
    }, []);

    return { mode: view.mode, gridCols: view.gridCols, setMode, setGridCols };
}
