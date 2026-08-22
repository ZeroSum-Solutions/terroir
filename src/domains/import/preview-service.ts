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
  resolution: "auto" | "pending" | "exclude";
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

  const lwinQueries = validated
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.state === "valid")
    .map(({ row, idx }) => ({
      idx,
      producer: (row as { producer: string }).producer,
      name: (row as { name: string }).name,
    }));

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
    };
  });

  const summary: PreviewSummary = {
    totalRows: rows.length,
    validRows: rows.filter((r) => r.rowState === "valid").length,
    errorRows: rows.filter((r) => r.rowState === "error").length,
    matchedRows: rows.filter((r) => r.lwinStatus === "matched").length,
    unmatchedRows: rows.filter((r) => r.rowState === "valid" && r.lwinStatus === "unmatched").length,
    missingCostRows: rows.filter((r) => r.rowState === "valid" && r.costStatus === "missing").length,
    readyToApplyRows: rows.filter((r) => r.resolution === "auto").length,
    pendingResolutionRows: rows.filter((r) => r.resolution === "pending").length,
  };

  return { ok: true, rows, summary };
}
