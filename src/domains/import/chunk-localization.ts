// GLOBAL -> LOCAL row-number translation for the three operator decision
// payloads. The aggregated chunked preview shows GLOBAL row numbers, but
// each chunk is re-parsed from scratch server-side (buildImportPreview),
// so row 1 of that upload is always the chunk's own first data row.
//
// Extracted verbatim from session-step.tsx, which re-exports all three
// unchanged.

import type { ApprovedLwinRows, RejectedLwinRows, RowOverrides } from "./review-types";

/** Translates the operator's overrides (keyed by the GLOBAL row number
 * the aggregated chunked preview shows) into the LOCAL row numbers one
 * chunk's own re-upload will assign — a chunk is re-parsed from scratch
 * server-side (buildImportPreview), so row 1 of that upload is always
 * the chunk's own first data row, never the original file's. */
export function localizeRowOverrides(
  globalOverrides: RowOverrides,
  chunk: { startRow: number; endRow: number },
): Record<string, Partial<Record<string, string>>> {
  const local: Record<string, Partial<Record<string, string>>> = {};
  for (const [key, fields] of Object.entries(globalOverrides)) {
    const globalRowNumber = Number(key);
    if (globalRowNumber < chunk.startRow || globalRowNumber > chunk.endRow) continue;
    local[String(globalRowNumber - chunk.startRow + 1)] = fields;
  }
  return local;
}

/** Item 2 (per-row LWIN match visibility/rejection) — the rejectedLwinRows
 * counterpart to localizeRowOverrides above: translates the operator's
 * rejected-row set (keyed by the GLOBAL row number the aggregated chunked
 * preview shows) into the LOCAL row numbers one chunk's own re-upload will
 * assign. */
export function localizeRejectedLwinRows(
  globalRejected: RejectedLwinRows,
  chunk: { startRow: number; endRow: number },
): string[] {
  const local: string[] = [];
  for (const globalRowNumber of globalRejected) {
    if (globalRowNumber < chunk.startRow || globalRowNumber > chunk.endRow) continue;
    local.push(String(globalRowNumber - chunk.startRow + 1));
  }
  return local;
}

/** BLOCK 2 (Sol audit round 3, finding 2) — the approvedLwinRows
 * counterpart to localizeRowOverrides above: translates the operator's
 * approved (row -> lwin_id) map (keyed by the GLOBAL row number the
 * aggregated chunked preview shows) into the LOCAL row numbers one
 * chunk's own re-upload will assign. */
export function localizeApprovedLwinRows(
  globalApproved: ApprovedLwinRows,
  chunk: { startRow: number; endRow: number },
): Record<string, string> {
  const local: Record<string, string> = {};
  for (const [key, lwinId] of Object.entries(globalApproved)) {
    const globalRowNumber = Number(key);
    if (globalRowNumber < chunk.startRow || globalRowNumber > chunk.endRow) continue;
    local[String(globalRowNumber - chunk.startRow + 1)] = lwinId;
  }
  return local;
}
