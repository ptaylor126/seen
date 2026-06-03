import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

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

export function useLibraryView() {
    const [view, setView] = useState<LibraryView>(DEFAULT_VIEW);
    // Pin the latest view so the write-on-change effect doesn't lag a
    // render behind the setter.
    const viewRef = useRef(view);
    viewRef.current = view;

    useEffect(() => {
        let active = true;
        AsyncStorage.getItem(STORAGE_KEY)
            .then((raw) => {
                if (!active || raw == null) return;
                try {
                    const parsed: unknown = JSON.parse(raw);
                    if (isValid(parsed)) setView(parsed);
                } catch {
                    // Corrupt entry — fall through to defaults already set.
                }
            })
            .catch(() => {
                // AsyncStorage read failure — stay on defaults.
            });
        return () => {
            active = false;
        };
    }, []);

    const setMode = useCallback((mode: LibraryMode) => {
        const next: LibraryView = { ...viewRef.current, mode };
        setView(next);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {
            // Write failure is silent — next change will retry.
        });
    }, []);

    const setGridCols = useCallback((gridCols: LibraryGridCols) => {
        const next: LibraryView = { ...viewRef.current, gridCols };
        setView(next);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
    }, []);

    return { mode: view.mode, gridCols: view.gridCols, setMode, setGridCols };
}
