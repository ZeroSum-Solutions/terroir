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
import type { CanonicalHeader } from "./constants";

const CATALOG_LOOKUP_PAGE_SIZE = 1000;

/** Sol audit round 3, finding 1: PostgREST caps a single response at
 * db.max_rows (1,000 — supabase/config.toml), but MAX_ROWS (constants.ts)
 * allows up to 5,000 matched rows per import, so the lwin_catalog display
 * name lookup below can't be a single unpaged query. Same fetchAll shape
 * as src/lib/cellar-health/recompute.ts and
 * src/app/api/member-analytics/route.ts, except this one degrades rather
 * than throws on a page error — preserving the lookup's existing
 * "a display-name lookup failure never fails the whole preview" contract
 * (see the call site below) while still reading every page it can. */
async function fetchAll<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += CATALOG_LOOKUP_PAGE_SIZE) {
    const { data, error } = await makeQuery(from, from + CATALOG_LOOKUP_PAGE_SIZE - 1);
    if (error) return rows;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < CATALOG_LOOKUP_PAGE_SIZE) return rows;
  }
}

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
   * match is the bigger risk than a low match rate ever was. null for an
   * unmatched row, or a matched row whose lwin_catalog row has since
   * disappeared (see the lookup below — degrades, never fails preview). */
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
  // bar (0108) before any lwin_id is written.
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

  // Item 2 (per-row LWIN match visibility): one lookup for every distinct
  // matched lwin_id, rather than one per row — lwin_catalog is RLS-readable
  // by any authenticated user (schema.snapshot.sql), and this is the FIRST
  // time application code queries it outside match_lwin_bulk's own SQL. A
  // catalog row that has since disappeared (or the lookup itself failing)
  // degrades that row's display name to null — the raw lwinId/lwinScore
  // this product actually writes are unaffected either way, so a lookup
  // failure never fails the whole preview.
  //
  // Sol audit round 3, finding 1: MAX_ROWS (constants.ts) allows 5,000
  // matched rows, so distinctLwinIds can exceed PostgREST's db.max_rows
  // cap (1,000 — supabase/config.toml). Paginates to exhaustion via the
  // same fetchAll pattern already used in src/lib/cellar-health/
  // recompute.ts, src/app/api/member-analytics/route.ts, and the cellar
  // page (src/app/(app)/cellar/page.tsx) for the identical PostgREST cap.
  // `.order("lwin_id")` is the tiebreaker so offset-based pagination can't
  // skip/duplicate rows on a tied sort key.
  const distinctLwinIds = Array.from(new Set(Array.from(matches.values(), (m) => m.lwinId)));
  const displayNames = new Map<string, string>();
  if (distinctLwinIds.length > 0) {
    const catalogRows = await fetchAll<{ lwin_id: string; display_name: string }>((from, to) =>
      supabase
        .from("lwin_catalog")
        .select("lwin_id, display_name")
        .in("lwin_id", distinctLwinIds)
        .order("lwin_id")
        .range(from, to),
    );
    for (const row of catalogRows) {
      displayNames.set(row.lwin_id, row.display_name);
    }
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
      lwinDisplayName: match ? (displayNames.get(match.lwinId) ?? null) : null,
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
