// G1-4 — server-side upload validation, independent of Next.js response
// types so it's trivial to unit test.

import {
  ALLOWED_CSV_MIME_TYPES,
  ALLOWED_SPREADSHEET_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "./constants";

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; code: "too_large" | "unsupported_media_type"; message: string };

export function validateUploadedCsvFile(file: { size: number; type: string; name: string }): UploadValidationResult {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "too_large", message: `File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  }

  const hasCsvExtension = file.name.toLowerCase().endsWith(".csv");
  const hasAllowedMime = file.type === "" || ALLOWED_CSV_MIME_TYPES.has(file.type);

  if (!hasCsvExtension || !hasAllowedMime) {
    return {
      ok: false,
      code: "unsupported_media_type",
      message: "Only .csv files are accepted.",
    };
  }

  return { ok: true };
}

/** Spreadsheets are validated on their own route (POST /api/import/convert),
 * which turns them into CSV before any other import code sees them. The size
 * ceiling is deliberately the same as CSV's: the conversion route holds the
 * whole workbook in memory, and an .xlsx is denser than the CSV it becomes, so
 * a 5 MB ceiling here is a larger import than a 5 MB ceiling there. */
export function validateUploadedSpreadsheetFile(file: {
  size: number;
  type: string;
  name: string;
}): UploadValidationResult {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "too_large", message: `File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  }

  const hasSpreadsheetExtension = file.name.toLowerCase().endsWith(".xlsx");
  const hasAllowedMime = file.type === "" || ALLOWED_SPREADSHEET_MIME_TYPES.has(file.type);

  if (!hasSpreadsheetExtension || !hasAllowedMime) {
    return {
      ok: false,
      code: "unsupported_media_type",
      // .xls is the legacy binary format exceljs cannot read; say so rather
      // than letting the conversion fail later with a vaguer error.
      message: "Only .xlsx files are accepted. Re-save a .xls or Numbers file as .xlsx, or export it as .csv.",
    };
  }

  return { ok: true };
}
