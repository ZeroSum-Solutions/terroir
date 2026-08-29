// Converts an uploaded .xlsx workbook into the exact CSV text the import
// pipeline already understands, so that a spreadsheet upload reuses every
// downstream rule — header matching, row validation, dedup keys, LWIN
// matching, chunk planning, digests — rather than growing a second, subtly
// different ingestion path beside the CSV one.
//
// The conversion is the ONLY spreadsheet-aware code in the import domain.
// Everything after it sees bytes indistinguishable from an uploaded .csv.

import ExcelJS from "exceljs";

import { MAX_SPREADSHEET_CSV_BYTES, MAX_SPREADSHEET_ROWS } from "./constants";

export type SpreadsheetErrorCode =
  | "unreadable_workbook"
  | "no_worksheets"
  | "empty_sheet"
  | "too_many_rows"
  | "too_large_converted";

export type SpreadsheetConversion =
  | { ok: true; csv: string; sheetName: string; rowCount: number; sheetCount: number }
  | { ok: false; code: SpreadsheetErrorCode; message: string };

/** Excel cell values are a tagged union, not strings: a cell can hold a
 * formula (whose *result* is what the operator sees), rich text runs, a
 * hyperlink, an error, a date, or a plain scalar. Rendering each to the text
 * the spreadsheet displays is what makes the converted CSV match what the
 * operator believes they uploaded. */
function renderCell(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // Excel dates carry a time component even when the cell is formatted as a
    // date. Emit a bare date when that component is midnight UTC so a vintage
    // or delivery date does not arrive downstream as an ISO timestamp.
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((run) => run.text).join("");
    }
    if ("formula" in value || "sharedFormula" in value) {
      // The formula's cached result is what Excel displays; the formula text
      // itself is meaningless to an importer.
      const result = (value as ExcelJS.CellFormulaValue).result;
      return result === undefined ? "" : renderCell(result as ExcelJS.CellValue);
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

/** Standard CSV quoting (RFC 4180): quote when the field contains a comma,
 * quote or newline, and double any embedded quote. Leading/trailing spaces are
 * quoted too so they survive a strict parser. */
function escapeCsvField(field: string): string {
  const needsQuoting =
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r") ||
    field !== field.trim();
  return needsQuoting ? `"${field.replaceAll('"', '""')}"` : field;
}

export async function convertSpreadsheetToCsv(buffer: Buffer): Promise<SpreadsheetConversion> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs accepts a Node Buffer here despite the ArrayBuffer-ish typing.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    // A corrupt archive, a password-protected workbook, or a .xls (the legacy
    // binary format, which is not a ZIP at all) all land here.
    return {
      ok: false,
      code: "unreadable_workbook",
      message:
        "That file could not be read as an Excel workbook. Save it as .xlsx or .csv and try again.",
    };
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { ok: false, code: "no_worksheets", message: "That workbook has no sheets." };
  }

  const rows: string[][] = [];
  let width = 0;
  let bytes = 0;
  let overflow: SpreadsheetErrorCode | null = null;

  // includeEmpty:false skips blank rows, matching what a spreadsheet export
  // would produce; a blank row carries no import data either way.
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (overflow) return;
    if (rows.length >= MAX_SPREADSHEET_ROWS) {
      overflow = "too_many_rows";
      return;
    }
    // row.values is 1-indexed with a leading hole, so drop element 0.
    const cells = (row.values as ExcelJS.CellValue[]).slice(1);
    const fields = cells.map((cell) => escapeCsvField(renderCell(cell)));
    bytes += fields.reduce((sum, field) => sum + Buffer.byteLength(field, "utf8") + 1, 1);
    if (bytes > MAX_SPREADSHEET_CSV_BYTES) {
      overflow = "too_large_converted";
      return;
    }
    if (fields.length > width) width = fields.length;
    rows.push(fields);
  });

  // exceljs drops trailing empty cells, so a row whose last column is blank —
  // an empty "notes" column, say — comes back SHORTER than the header. Emitted
  // as-is that produces a ragged CSV whose columns no longer line up with the
  // header, which is exactly the kind of silent misimport this conversion
  // exists to avoid. Pad every row to the widest one.
  const lines = rows.map((fields) =>
    fields.concat(Array.from({ length: width - fields.length }, () => "")).join(","),
  );

  if (overflow === "too_many_rows") {
    return {
      ok: false,
      code: "too_many_rows",
      message: `That sheet has more than ${MAX_SPREADSHEET_ROWS.toLocaleString()} rows. Split it and upload the parts separately.`,
    };
  }
  if (overflow === "too_large_converted") {
    return {
      ok: false,
      code: "too_large_converted",
      message: "That sheet holds too much data to import in one go. Split it and upload the parts separately.",
    };
  }
  if (lines.length === 0) {
    return { ok: false, code: "empty_sheet", message: "That sheet is empty." };
  }

  return {
    ok: true,
    csv: lines.join("\n"),
    sheetName: worksheet.name,
    // Header row is not import data; report what the operator would count.
    rowCount: lines.length - 1,
    sheetCount: workbook.worksheets.length,
  };
}
