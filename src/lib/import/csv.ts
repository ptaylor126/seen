/**
 * Minimal strict CSV parser (RFC 4180): quoted fields, "" escapes,
 * commas + newlines inside quotes, CRLF/LF line ends, UTF-8 BOM strip.
 * Hand-rolled instead of a dependency — the two source formats we read
 * (Letterboxd, IMDb exports) are machine-generated RFC-conformant CSV,
 * and this keeps the OTA bundle free of a parsing library.
 */

export interface CsvTable {
    header: string[];
    rows: string[][];
}

export function parseCsv(text: string): CsvTable {
    // Strip a UTF-8 BOM if present (IMDb exports carry one).
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const records: string[][] = [];
    let field = '';
    let record: string[] = [];
    let inQuotes = false;
    let fieldHadContent = false; // distinguishes a bare newline from "" on its own line

    const pushField = () => {
        record.push(field);
        field = '';
    };
    const pushRecord = () => {
        pushField();
        // Skip fully-empty records (trailing newline, blank lines).
        if (record.length === 1 && record[0] === '' && !fieldHadContent) {
            record = [];
            return;
        }
        records.push(record);
        record = [];
        fieldHadContent = false;
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            fieldHadContent = true;
        } else if (ch === ',') {
            pushField();
            fieldHadContent = true;
        } else if (ch === '\n') {
            pushRecord();
        } else if (ch === '\r') {
            // CRLF — consume the \r, let \n close the record; a lone \r
            // (old-Mac line ends, never produced by our sources) also
            // closes the record.
            if (text[i + 1] !== '\n') pushRecord();
        } else {
            field += ch;
            fieldHadContent = true;
        }
    }
    // Final record when the file doesn't end in a newline.
    if (field.length > 0 || record.length > 0) pushRecord();

    const [header = [], ...rows] = records;
    return { header, rows };
}

/**
 * Map rows to objects keyed by header name. Header lookup is
 * case-insensitive and trimmed so "Year " vs "year" never bites.
 * Missing cells (short rows) read as ''.
 */
export function csvObjects(table: CsvTable): Array<Record<string, string>> {
    const keys = table.header.map((h) => h.trim().toLowerCase());
    return table.rows.map((row) => {
        const obj: Record<string, string> = {};
        keys.forEach((k, i) => {
            obj[k] = row[i] ?? '';
        });
        return obj;
    });
}
