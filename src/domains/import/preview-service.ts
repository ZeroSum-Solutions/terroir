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
import { mapHeader, validateRow, type FieldError, type FieldsInput, type RawRowFields } from "./row-validator";
import { matchLwinBulk, buildLwinQueryVariants, type LwinMatch } from "./lwin-matching";
import { mergeIntraBatchDuplicates, type IntraBatchDuplicateReason } from "./dedup-key";
import { LWIN_MATCH_MAX_QUERIES, type CanonicalHeader } from "./constants";

/** Inline row-fix overrides (see ConfirmBatchOptions.rowOverrides in
 * batch-service.ts), keyed by the 1-indexed data row number a caller
 * would have seen in this exact file's own preview — the same numbering
 * validated/bounds-checked below, before row-validator.ts's own
 * validation ever runs on the overridden text. */
export type RowOverrides = Record<string, FieldsInput>;

export type PreviewRow = {
  rowNumber: number;
  raw: RawRowFields;
  /** See ValidatedRow.rawText (row-validator.ts) — the exact text this
   * row was validated against, for every canonical field, so an inline
   * row-fix UI can prefill an edit form even for a field that failed its
   * own validation (and so `raw` nulled out). */
  rawText: Record<CanonicalHeader, string>;
  rowState: "valid" | "error";
  errors: FieldError[];
  lwinStatus: "matched" | "unmatched";
  lwinId: string | null;
  lwinScore: number | null;
  /** Item 2 (per-row LWIN match visibility): the catalog's own display_name
   * for lwinId, so the operator can SEE what a match actually claims this
   * wine is, not just an opaque id + a score — the gap a Sol audit BLOCKed
   * PR #133 (variant matching) over: at a 77% match rate, a silent wrong
   * match is the bigger risk than a low match rate ever was.
   *
   * BLOCK 2 (round-13 fix) — this is match_lwin_bulk's OWN display_name
   * (0076_csv_import_batches.sql), carried straight through matchLwinBulk
   * (lwin-matching.ts) and the best-of-variants reduction below. There used
   * to be a SECOND, separately-paginated lwin_catalog lookup here that
   * re-fetched a name match_lwin_bulk had already returned — deleted
   * outright (see docs/runbooks/csv-import.md) rather than patched, since
   * the RPC's own result already carries everything this field needs. null
   * for an unmatched row, or the rare case where match_lwin_bulk's own join
   * returns a null display_name (never fails preview either way). */
  lwinDisplayName: string | null;
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
  rowOverrides?: RowOverrides,
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

  // rowOverrides is keyed to THIS file's own row numbers (a chunked
  // upload re-parses one chunk at a time, each with its own row 1) — an
  // index outside what this file actually contains is a stale/mismatched
  // client reference, never silently ignored, so confirm fails loudly
  // instead of dropping an operator's edit on the floor.
  if (rowOverrides) {
    for (const key of Object.keys(rowOverrides)) {
      const rowNumber = Number(key);
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > parsed.rows.length) {
        return {
          ok: false,
          error: {
            code: "invalid_row_override",
            message: `Row ${key} does not exist in this file (it has ${parsed.rows.length} data row(s)).`,
          },
        };
      }
    }
  }

  const validated = parsed.rows.map((cells, idx) => validateRow(cells, columnToField, rowOverrides?.[String(idx + 1)]));

  // Producer-less rows (real-world single-"Wine Name"-column exports) are
  // matched with several query variants — full name in both legs, plus the
  // leading 2/3 name tokens as the producer leg (see buildLwinQueryVariants
  // for the measured rationale) — and each row keeps its best-scoring
  // match. Weak candidates are still held to apply's own 0.6 confidence
  // bar (0108) before any lwin_id is written. A row that failed validation
  // never reaches matching at all (filtered out below), so only VALID rows
  // ever generate a query.
  const variantOwners: number[] = [];
  const lwinQueries = validated
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.state === "valid")
    .flatMap(({ row, idx }) => {
      const { producer, name } = row as { producer: string; name: string };
      return buildLwinQueryVariants(producer, name).map((variant) => {
        variantOwners.push(idx);
        return { idx: variantOwners.length - 1, ...variant };
      });
    });

  // BLOCK 2 (round 7 fix) — budgets the file/chunk's ACTUAL total generated
  // query count (a producer-bearing row contributes 1, a producer-less row
  // up to 3 — buildLwinQueryVariants above), never just the producer-less
  // subset alone. Checked BEFORE any LWIN RPC call is made (lwinQueries is
  // already fully built above, but matchLwinBulk hasn't been called yet) —
  // see LWIN_MATCH_MAX_QUERIES' own comment (constants.ts) for the
  // derivation this bound comes from, and why the previous version of this
  // check (PRODUCER_LESS_MAX_ROWS, counting only producer-less rows) let a
  // mixed file's real query count exceed the same budget it was meant to
  // enforce.
  //
  // WARN 5 (round-29 audit) — this same check runs at both call sites
  // (preview: no rowOverrides; confirm: with them — see
  // LWIN_MATCH_MAX_QUERIES' own comment, constants.ts, for why that means
  // preview and confirm are NOT guaranteed to agree). A row an override
  // fixed from invalid to valid contributes queries here that preview's
  // own count never included, since preview never saw the fix. When
  // rowOverrides is present and non-empty, the message below says so
  // explicitly, so a file that passed preview and then fails here reads as
  // an explained consequence of the fixes just applied, never an
  // unexplained regression.
  if (lwinQueries.length > LWIN_MATCH_MAX_QUERIES) {
    const overrideCount = rowOverrides ? Object.keys(rowOverrides).length : 0;
    const overrideNote =
      overrideCount > 0
        ? ` This count reflects the ${overrideCount} row fix${overrideCount === 1 ? "" : "es"} applied since ` +
          `preview — preview only counts a row toward this budget once it is valid, so fixing a row here can ` +
          `raise the total beyond what preview showed.`
        : "";
    return {
      ok: false,
      error: {
        code: "too_many_lwin_match_queries",
        message:
          `This file would generate ${lwinQueries.length} wine-catalog match queries — a producer-less row ` +
          `("Wine Name" only, no producer/winery) needs up to 3 queries, a row with a producer needs 1 — and ` +
          `matching that many at once cannot complete reliably.${overrideNote} Add a producer/winery value to ` +
          `more rows, or split this file into smaller chunks so no single upload generates more than ` +
          `${LWIN_MATCH_MAX_QUERIES} match queries.`,
      },
    };
  }

  const variantMatches = await matchLwinBulk(supabase, lwinQueries);
  // Reduce best-per-row over ASCENDING flat index, not Map iteration
  // order (which follows RPC row order and is not guaranteed): with
  // strict >, an exact score tie deterministically keeps the
  // lowest-variant-index match, so preview and confirm — which each
  // rerun matching independently — always pick the same winner.
  const matches = new Map<number, LwinMatch>();
  for (let variantIdx = 0; variantIdx < variantOwners.length; variantIdx++) {
    const match = variantMatches.get(variantIdx);
    if (!match) continue;
    const rowIdx = variantOwners[variantIdx];
    const current = matches.get(rowIdx);
    if (!current || match.score > current.score) matches.set(rowIdx, match);
  }

  const rows: PreviewRow[] = validated.map((row, idx) => {
    const rowNumber = idx + 1;

    if (row.state === "error") {
      return {
        rowNumber,
        raw: row.raw,
        rawText: row.rawText,
        rowState: "error",
        errors: row.errors,
        lwinStatus: "unmatched",
        lwinId: null,
        lwinScore: null,
        lwinDisplayName: null,
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
      rawText: row.rawText,
      rowState: "valid",
      errors: [],
      lwinStatus,
      lwinId: match?.lwinId ?? null,
      lwinScore: match?.score ?? null,
      lwinDisplayName: match?.displayName ?? null,
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
