// G1-4 — CSV import preview: parse + validate + LWIN-match, zero writes.
//
// This is the single source of truth for "what does this file mean" —
// both the preview endpoint (stops here) and the confirm/create-batch
// endpoint (persists this exact output) call buildImportPreview. The
// confirm endpoint receives the raw file again and re-derives this from
// scratch; it never trusts a client-supplied preview payload, which
// would otherwise let a tampered client claim a row is valid/matched
// when the server's own parse says otherwise.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { decodeCsvBuffer, parseCsv } from "./csv-parser";
import { mapHeader, validateRow, type FieldError, type RawRowFields } from "./row-validator";
import { matchLwinBulk } from "./lwin-matching";
import { mergeIntraBatchDuplicates, type IntraBatchDuplicateReason } from "./dedup-key";
import type { CanonicalHeader } from "./constants";

export type PreviewRow = {
  rowNumber: number;
  raw: RawRowFields;
  rowState: "valid" | "error";
  errors: FieldError[];
  lwinStatus: "matched" | "unmatched";
  lwinId: string | null;
  lwinScore: number | null;
  costStatus: "present" | "missing";
  resolution: "auto" | "pending" | "include" | "exclude";
  /** P3 §1.5 tier 1: row numbers of other rows in this same upload that
   * were auto-merged into this one (same wine + location + cost +
   * currency, quantity summed). Empty when this row wasn't a merge
   * survivor. */
  mergedFromRowNumbers: number[];
  /** P3 §1.5: populated for tier-1 (intra-batch cost/currency conflict,
   * computed here) or left null here and populated later by
   * create_import_batch (0107) for tier-2 (cross-batch/session) —
   * distinguishes WHY resolution === 'pending' alongside lwinStatus/
   * costStatus, without inventing a new resolution enum value. */
  duplicateReason: IntraBatchDuplicateReason | null;
};

export type PreviewSummary = {
  totalRows: number;
  validRows: number;
  errorRows: number;
  matchedRows: number;
  unmatchedRows: number;
  missingCostRows: number;
  readyToApplyRows: number;
  pendingResolutionRows: number;
};

export type PreviewResult =
  | { ok: true; rows: PreviewRow[]; summary: PreviewSummary }
  | { ok: false; error: { code: string; message: string; missingHeaders?: CanonicalHeader[] } };

export async function buildImportPreview(
  supabase: SupabaseClient<Database>,
  fileBuffer: Buffer,
): Promise<PreviewResult> {
  const text = decodeCsvBuffer(fileBuffer);
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const { columnToField, missingRequired } = mapHeader(parsed.header);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      error: {
        code: "missing_headers",
        message: `CSV is missing required column(s): ${missingRequired.join(", ")}.`,
        missingHeaders: missingRequired,
      },
    };
  }

  const validated = parsed.rows.map((cells) => validateRow(cells, columnToField));

  // Producer-less rows (real-world single-"Wine Name"-column exports) put
  // the full name into BOTH match legs: match_lwin (0078) hard-gates on
  // producer-leg similarity, so an empty producer would never match — and
  // the full name contains the producer anyway. Weak candidates are still
  // held to apply's own 0.6 confidence bar (0108) before any lwin_id is
  // written.
  const lwinQueries = validated
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.state === "valid")
    .map(({ row, idx }) => {
      const { producer, name } = row as { producer: string; name: string };
      return { idx, producer: producer || name, name };
    });

  const matches = await matchLwinBulk(supabase, lwinQueries);

  const rows: PreviewRow[] = validated.map((row, idx) => {
    const rowNumber = idx + 1;

    if (row.state === "error") {
      return {
        rowNumber,
        raw: row.raw,
        rowState: "error",
        errors: row.errors,
        lwinStatus: "unmatched",
        lwinId: null,
        lwinScore: null,
        costStatus: "present",
        resolution: "exclude",
        mergedFromRowNumbers: [],
        duplicateReason: null,
      };
    }

    const match = matches.get(idx);
    const lwinStatus: "matched" | "unmatched" = match ? "matched" : "unmatched";
    const costStatus: "present" | "missing" = row.costMissing ? "missing" : "present";
    const needsResolution = lwinStatus === "unmatched" || costStatus === "missing";

    return {
      rowNumber,
      raw: row.raw,
      rowState: "valid",
      errors: [],
      lwinStatus,
      lwinId: match?.lwinId ?? null,
      lwinScore: match?.score ?? null,
      costStatus,
      resolution: needsResolution ? "pending" : "auto",
      mergedFromRowNumbers: [],
      duplicateReason: null,
    };
  });

  // P3 §1.5 tier 1: collapse intra-batch exact duplicates (same wine +
  // location + cost + currency, within this one upload) into one row with
  // summed quantity, before this file's row count is ever reported or
  // persisted. A wine+location match that DISAGREES on cost/currency is
  // never merged — both rows are surfaced as resolution = 'pending'
  // instead (§1.5's own reasoning: a merged row would silently overwrite
  // a real financial fact with no way to reconstruct it later).
  const mergedRows = mergeIntraBatchDuplicates(rows);

  const summary: PreviewSummary = {
    totalRows: mergedRows.length,
    validRows: mergedRows.filter((r) => r.rowState === "valid").length,
    errorRows: mergedRows.filter((r) => r.rowState === "error").length,
    matchedRows: mergedRows.filter((r) => r.lwinStatus === "matched").length,
    unmatchedRows: mergedRows.filter((r) => r.rowState === "valid" && r.lwinStatus === "unmatched").length,
    missingCostRows: mergedRows.filter((r) => r.rowState === "valid" && r.costStatus === "missing").length,
    readyToApplyRows: mergedRows.filter((r) => r.resolution === "auto").length,
    pendingResolutionRows: mergedRows.filter((r) => r.resolution === "pending").length,
  };

  return { ok: true, rows: mergedRows, summary };
}
