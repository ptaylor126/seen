/**
 * Import source registry — the single place that knows which sources
 * exist and how to parse each one. TV Time (stage 3) plugs in here:
 * add 'tvtime' to ImportSource in ./types.ts, write its parser, add a
 * SourceDefinition below. The screens iterate this registry and need
 * no changes for a new source.
 */
import { parseImdb } from './imdb';
import { parseLetterboxd } from './letterboxd';
import type { ImportSource, ParseResult, PickedFile } from './types';

export interface SourceDefinition {
    id: ImportSource;
    label: string;
    // Short instruction steps rendered on the source screen.
    instructions: string[];
    // What the document picker accepts. iOS matches on UTI derived from
    // MIME; Android passes these through to the system picker. CSV
    // exports are served with varying MIME types (text/csv,
    // text/comma-separated-values, application/octet-stream from some
    // download paths) so the lists are generous; the parser is the real
    // gate.
    pickerTypes: string[];
    parse(file: PickedFile): ParseResult;
}

const CSV_TYPES = [
    'text/csv',
    'text/comma-separated-values',
    'application/csv',
    'application/octet-stream',
];

export const IMPORT_SOURCES: Record<ImportSource, SourceDefinition> = {
    letterboxd: {
        id: 'letterboxd',
        label: 'Letterboxd',
        instructions: [
            'On letterboxd.com, open Settings, then Data.',
            'Tap "Export your data" and download the ZIP file.',
            'Pick that ZIP below. A single CSV from inside it works too.',
        ],
        pickerTypes: ['application/zip', 'application/x-zip-compressed', ...CSV_TYPES],
        parse: parseLetterboxd,
    },
    imdb: {
        id: 'imdb',
        label: 'IMDb',
        instructions: [
            'On the imdb.com desktop site (the app can’t export), open your profile menu and choose "Your Ratings".',
            'Tap the three-dot "Actions" menu at the top right, then "Export".',
            'IMDb prepares the file in the background. This can take a few minutes even for small libraries.',
            'Open the exports page (imdb.com/exports). When your export shows "Ready", tap it and the CSV downloads.',
            'Pick the downloaded file below. Ratings and watchlist are separate exports from their own pages, and the ratings file contains only rated titles. Want your watchlist too? Export it the same way and run it through here afterwards.',
        ],
        pickerTypes: CSV_TYPES,
        parse: parseImdb,
    },
};

export const IMPORT_SOURCE_LIST: SourceDefinition[] =
    Object.values(IMPORT_SOURCES);
