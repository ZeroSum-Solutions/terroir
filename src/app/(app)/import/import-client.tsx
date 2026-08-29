"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Upload,
} from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import { cn } from "@/lib/utils";
import {
  CANONICAL_HEADERS,
  CLIENT_CHUNK_TARGET_ROWS,
  LWIN_APPLY_MIN_SCORE,
  MAX_FIELD_LENGTH,
  MAX_ROWS,
  type CanonicalHeader,
} from "@/domains/import/constants";
import { validateFields } from "@/domains/import/row-validator";
import {
  AmbiguousRecordSplitError,
  UnsupportedEncodingError,
  UnsupportedLineEndingError,
  buildChunkPlan,
  decodeCsvBytesStrict,
  splitLogicalRecords,
} from "@/domains/import/csv-splitter";
import type { PreviewRow, PreviewSummary } from "@/domains/import/preview-service";
import {
  SessionStep,
  ChunkUploadProgress,
  estimateChunkedPhaseWaitSeconds,
  planChunkedPreview,
  confirmChunkedSessionWithResume,
  readStoredSession,
  writeStoredSession,
  ZERO_SUMMARY,
  type ChunkedPlanState,
  type ChunkedPreviewState,
  type ChunkUploadState,
} from "./session-step";
import { convertSpreadsheetFile, isSpreadsheetFile } from "./spreadsheet-upload";
import { takeHandoffFile } from "./spreadsheet-handoff";

/** BLOCK 1 (round-11 fix) — how many preview/confirm "units" (chunks, or 1
 * for a file at/under MAX_ROWS that never gets split) this file will need,
 * computed eagerly as soon as a file is selected so the operator wait
 * estimate (estimateChunkedPhaseWaitSeconds) is known BEFORE they commit to
 * either phase, not merely once they've already clicked Preview. Shares the
 * exact decode/split/chunk-plan functions handlePreview itself uses (see
 * below), so the early estimate and the actual preview path can never
 * disagree on chunk count. Returns null for a file that can't even be
 * decoded/split — an early estimate has nothing honest to show for a file
 * that's about to fail outright; handlePreview surfaces the real error once
 * the operator actually clicks Preview. */
async function countPreviewUnits(file: File): Promise<number | null> {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const text = decodeCsvBytesStrict(bytes);
    const allRecords = splitLogicalRecords(text);
    if (allRecords.length === 0) return null;
    const dataRecords = allRecords.slice(1);
    if (dataRecords.length <= MAX_ROWS) return 1;
    return buildChunkPlan(dataRecords, CLIENT_CHUNK_TARGET_ROWS).length;
  } catch {
    return null;
  }
}

/** BLOCK 1 (round-13 fix) — countPreviewUnits (above) resolves
 * asynchronously (it reads the whole file), so the wait estimate it
 * produces is NOT available the instant a file is selected. Without
 * tracking that gap explicitly, two races were possible: (1) an operator
 * could click Preview in the window before the estimate ever resolves,
 * seeing no disclosure at all; (2) switching from a small file to a large
 * one kept showing the SMALL file's stale estimate/unit count until the
 * new one resolved, so a click in that window committed to the wrong
 * file's wait. "pending" is set SYNCHRONOUSLY, DURING RENDER, the instant
 * `file` changes (see the ImportClient state declared with this type, below —
 * a render-phase state adjustment, not an effect), clearing whatever the
 * previous file's status was — Preview stays disabled for the whole
 * "pending" window on either race. "unavailable" (the file couldn't even
 * be decoded/split) still allows a click: handlePreview's own real
 * decode/split surfaces the actual error, there is nothing more honest to
 * gate on here. */
type PreviewUnitsStatus = "idle" | "pending" | "ready" | "unavailable";

/** One error row's worth of prefill text for the inline row-fix form —
 * the exact text the row was validated against, for every canonical
 * field (see row-validator.ts's ValidatedRow.rawText). rowNumber is the
 * override-targeting key (see RowOverrides below) — for the chunked path
 * it's a startRow-adjusted pseudo-global number that must NEVER be
 * changed (session-step.tsx's localizeRowOverrides depends on its exact
 * arithmetic). chunkIndex/chunkRowNumber are set ONLY for the chunked
 * path and carry the HONEST display label instead (Sol round-2 audit
 * (2026-08-27) finding 5) — RowFixItem renders "Chunk N, data row M"
 * from these two when present, never a claim that rowNumber is this
 * row's true physical position in the original file. */
export type ErrorRowEntry = {
  rowNumber: number;
  chunkIndex?: number;
  chunkRowNumber?: number;
  errors: { field: string; message: string }[];
  rawText: Record<CanonicalHeader, string>;
};

/** Item 2 (per-row LWIN match visibility): one matched row's worth of
 * display info for the "Matched wines" section — same rowNumber/chunkIndex/
 * chunkRowNumber convention as ErrorRowEntry above (GLOBAL row number for
 * both paths; chunkIndex/chunkRowNumber set ONLY for the chunked path, for
 * the same honest "Chunk N, data row M" label). lwinId is carried so a
 * reject toggle always knows exactly which match it's rejecting, even
 * though it isn't rendered directly. */
export type MatchedLwinRowEntry = {
  rowNumber: number;
  chunkIndex?: number;
  chunkRowNumber?: number;
  lwinId: string;
  lwinDisplayName: string | null;
  lwinScore: number;
};

/** rowNumber -> true for a matched row whose LWIN link the operator
 * rejected. GLOBAL row numbers, same keying as RowOverrides/ErrorRowEntry.
 * Sent to confirm as an explicit rejectedLwinRows payload — server-side
 * re-validation stays the sole authority (a rejected row that no longer
 * matches at confirm time, e.g. because an override also changed its text,
 * is simply a harmless no-op there — see applyLwinRejections'
 * (batch-service.ts) own comment). */
export type RejectedLwinRows = Set<number>;

/** BLOCK 2 (Sol audit round 3, finding 2) — GLOBAL row number -> the
 * lwin_id the operator saw and accepted for that row in preview. Built
 * fresh at confirm time from the CURRENT matched-rows list (never a
 * separate piece of user-editable state — there is nothing for the
 * operator to "set" here beyond what preview already showed), and sent as
 * an explicit approvedLwinRows payload so confirm's own from-scratch
 * re-match can VETO a disagreeing result instead of silently persisting
 * it — see applyLwinApprovalVeto's (batch-service.ts) own comment for the
 * full mechanics and why this can never let confirm write MORE or
 * DIFFERENT than its own re-match already decided. */
export type ApprovedLwinRows = Record<number, string>;

/** BLOCK 2 — builds the approvedLwinRows payload for one confirm attempt
 * from the matched rows currently shown to the operator: every row at or
 * above the apply threshold (LWIN_APPLY_MIN_SCORE) gets its currently
 * shown lwin_id echoed back. Below-threshold matches are excluded — apply
 * never stamps those regardless of agreement (BLOCK 3), so there is
 * nothing for the veto to ever protect there. Included even for a row the
 * operator has separately rejected (rejectedLwinRows) — applyLwinApprovalVeto
 * runs AFTER rejections are applied server-side, so an approved entry for
 * an already-rejected row is a harmless no-op, never double-processed.
 *
 * BLOCK 2 (round-13 fix) — an apply-eligible row is ALSO excluded when it
 * has no display identity (lwinDisplayName === null): the operator was
 * never actually shown what this match claims to be (see
 * MatchedLwinRowItem/its `linkingMatchedRows` filter below, which apply
 * the identical condition so a no-identity row is never rendered as
 * "linking" in the first place), so there is nothing here for them to have
 * approved. Excluding it here is what makes that failure mode fail
 * CLOSED: applyLwinApprovalVeto (batch-service.ts) treats any apply-
 * eligible row absent from this payload exactly like an explicit
 * rejection, so a match match_lwin_bulk itself returned with no name can
 * never be auto-stamped — this residual should be all but impossible now
 * that display_name comes straight off the same RPC row as lwinId/score
 * (lwin-matching.ts), but the gate stays defensive rather than assuming
 * that invariant forever. */
export function buildApprovedLwinRows(matchedRows: MatchedLwinRowEntry[]): ApprovedLwinRows {
  const approved: ApprovedLwinRows = {};
  for (const row of matchedRows) {
    if (row.lwinScore >= LWIN_APPLY_MIN_SCORE && row.lwinDisplayName !== null) approved[row.rowNumber] = row.lwinId;
  }
  return approved;
}

/** Builds the MatchedLwinRowEntry[] shape PreviewStep (and, via
 * buildApprovedLwinRows, handleConfirm) both need, from the plain
 * (non-chunked) preview's own rows — extracted so the two call sites can
 * never drift on what counts as "matched" for the single-file path. The
 * chunked path already gets this shape directly from planChunkedPreview
 * (session-step.tsx's ChunkedPreviewState.matchedRows). */
function matchedRowsFromPreviewRows(rows: PreviewRow[]): MatchedLwinRowEntry[] {
  return rows
    .filter((r): r is PreviewRow & { lwinId: string; lwinScore: number } => r.lwinStatus === "matched" && r.lwinId !== null)
    .map((r) => ({
      rowNumber: r.rowNumber,
      lwinId: r.lwinId,
      lwinDisplayName: r.lwinDisplayName,
      lwinScore: r.lwinScore,
    }));
}

/** rowNumber -> canonical field -> the operator's edited replacement
 * text. Sent to confirm as an explicit overrides payload — server-side
 * validation stays the sole authority (see request-schemas.ts's
 * RowOverridesSchema and batch-service.ts's confirmImportBatch). */
export type RowOverrides = Record<number, Partial<Record<CanonicalHeader, string>>>;

/** Sol round-2 audit (2026-08-27) finding 1: which GLOBAL row numbers
 * currently belong to an already-CONFIRMED chunk. confirmChunkedSession's
 * retry loop skips a chunk once it's "confirmed" (session-step.tsx) —
 * further edits to that chunk's rows can never actually be resent, so
 * leaving their inputs enabled would silently discard the operator's
 * fix with no signal at all. Exported as a pure function so its boundary
 * behavior can be pinned directly, without rendering the full component
 * tree. Always false for the plain (non-chunked) path. */
export function isRowInConfirmedChunk(
  rowNumber: number,
  chunkedPlan: ChunkedPlanState | null,
  chunkUpload: ChunkUploadState[] | null,
): boolean {
  if (!chunkedPlan || !chunkUpload) return false;
  return chunkedPlan.chunks.some((chunk) => {
    if (rowNumber < chunk.startRow || rowNumber > chunk.endRow) return false;
    return chunkUpload.find((u) => u.index === chunk.index)?.status === "confirmed";
  });
}

/** Round-6 audit finding 5: the skipped-chunk counterpart of
 * isRowInConfirmedChunk — a skipped chunk's rows were never sent to the
 * server at all, so an edit here is just as impossible to ever resend as
 * one on a confirmed chunk's rows. Kept as a SEPARATE predicate (rather
 * than folding into isRowInConfirmedChunk) because RowFixItem needs to
 * render a distinct, honest message for each case. */
export function isRowInSkippedChunk(
  rowNumber: number,
  chunkedPlan: ChunkedPlanState | null,
  chunkUpload: ChunkUploadState[] | null,
): boolean {
  if (!chunkedPlan || !chunkUpload) return false;
  return chunkedPlan.chunks.some((chunk) => {
    if (rowNumber < chunk.startRow || rowNumber > chunk.endRow) return false;
    return chunkUpload.find((u) => u.index === chunk.index)?.status === "skipped";
  });
}

/** Round-5 audit finding 4: marks a chunk stuck on duplicate_chunk_content
 * "skipped" — client-side only (see ChunkUploadState's own comment).
 * confirmChunkedSession never re-attempts a "skipped" chunk, and it no
 * longer counts toward PreviewStep's blocksConfirmButton, so the operator
 * can proceed with every OTHER chunk instead of being stuck forever on one
 * they've decided not to import.
 *
 * Round-6 audit finding 5: error/code are no longer nulled out on skip —
 * both are only ever read while a chunk's status is "failed" (the
 * unresolvedDuplicateChunkContentIndexes gate, and ChunkUploadProgress's
 * own error-line rendering), so keeping them costs nothing and is what
 * lets undoSkipChunk below restore the exact failed state, without
 * reconstructing anything. Exported as a pure function (round-7 audit
 * finding 6) so the real skip transition can be pinned directly, through
 * actual rendered state, rather than a hand-authored fixture. */
export function skipChunk(upload: ChunkUploadState[], index: number): ChunkUploadState[] {
  return upload.map((c) => (c.index === index ? { ...c, status: "skipped" } : c));
}

/** Round-6 audit finding 5: the inverse of skipChunk — restores a skipped
 * chunk to its prior failed/duplicate_chunk_content state, with both
 * "Import anyway" and "Skip this chunk" available again. Skip is purely
 * client-side state (see ChunkUploadState's own comment), so undoing it is
 * too: nothing server-side was ever touched. Exported as a pure function
 * for the same reason as skipChunk above. */
export function undoSkipChunk(upload: ChunkUploadState[], index: number): ChunkUploadState[] {
  return upload.map((c) => (c.index === index && c.status === "skipped" ? { ...c, status: "failed" } : c));
}

const FIELD_LABELS: Record<CanonicalHeader, string> = {
  producer: "Producer",
  name: "Name",
  vintage: "Vintage",
  varietal: "Varietal",
  region: "Region",
  country: "Country",
  size_ml: "Size (ml)",
  format: "Format",
  currency: "Currency",
  quantity: "Quantity",
  unit_cost: "Unit cost",
  bin: "Bin",
  section: "Section",
};

export type BatchSummary = {
  id: string;
  filename: string;
  status: "created" | "applying" | "completed" | "reverted";
  total_rows: number;
  created_at: string;
  reverted_at: string | null;
};

export type BatchRow = {
  id: string;
  row_number: number;
  raw: Record<string, string | null>;
  row_state: "valid" | "error";
  validation_errors: { field: string; message: string }[];
  lwin_status: "matched" | "unmatched";
  lwin_id: string | null;
  /** Item 2 (per-row LWIN match visibility): the server (GET /api/import/
   * batches/[id]) already sends this — it was previously dropped here even
   * though every persisted row carries it (import_batch_rows.lwin_score). */
  lwin_score: number | null;
  cost_status: "present" | "missing";
  resolution: "auto" | "pending" | "include" | "exclude";
  manual_unit_cost: number | null;
  apply_status: "not_applied" | "applied" | "reverted";
};

export type BatchDetail = { batch: BatchSummary; rows: BatchRow[] };

type Step = "upload" | "preview" | "batch" | "session";

const TEMPLATE_CSV = `${CANONICAL_HEADERS.join(",")}\nDomaine Example,Cuvee One,2020,Pinot Noir,Burgundy,France,750,,USD,6,24.50,,\n`;

// Round-1 fix: only the first N error rows were ever shown/editable, with
// any beyond this hard cap silently excluded from an inline fix — no
// second chance, and the overflow warning never went away. Sol round-2
// audit (2026-08-27) finding 4: PreviewStep now uses this as the initial
// PAGE size instead of a hard cap — "Show N more" reveals the next
// MAX_SHOWN_ERROR_ROWS rows, repeatable until every error row is shown,
// and the overflow warning disappears once nothing is left hidden.
export const MAX_SHOWN_ERROR_ROWS = 100;

// Item 2 (per-row LWIN match visibility): same incremental-disclosure
// pattern as MAX_SHOWN_ERROR_ROWS above, for the "Matched wines" section —
// at PR #133's measured 77% match rate, a file at the MAX_ROWS (5000)
// ceiling can have thousands of matched rows, which would otherwise render
// unbounded.
export const MAX_SHOWN_MATCHED_ROWS = 100;

// Stable empty defaults for PreviewStep's optional matchedRows/
// rejectedLwinRows props — module-level so every render that omits them
// (every pre-existing caller) reuses the SAME reference rather than
// allocating a fresh empty array/Set every render.
const EMPTY_MATCHED_ROWS: MatchedLwinRowEntry[] = [];
const EMPTY_REJECTED_LWIN_ROWS: RejectedLwinRows = new Set();

/** Round-5 audit finding 3: whether two override slices for the same chunk
 * are the SAME edit — an order-independent, deep value comparison used
 * only to gate the "Retry upload" button on a chunk stuck at
 * duplicate_chunk_content (an unchanged override reproduces the identical
 * canonical overrides JSON server-side, hence the identical namespaced
 * digest, hence the identical collision, forever). It does NOT need to
 * exactly mirror batch-service.ts's own canonicalizeRowOverrides — that
 * function is server-only (pulls in node:crypto, never importable from a
 * client component) — it only needs to reliably distinguish "identical"
 * from "different"; the server's own digest remains the actual authority
 * on whether a retry produces a new content_sha256. */
function overridesSliceEqual(
  a: Record<number, Partial<Record<CanonicalHeader, string>>>,
  b: Record<number, Partial<Record<CanonicalHeader, string>>>,
): boolean {
  const normalize = (slice: Record<number, Partial<Record<CanonicalHeader, string>>>) =>
    Object.entries(slice)
      .map(([rowNumber, fields]) => [
        Number(rowNumber),
        Object.entries(fields ?? {})
          .filter(([, value]) => value !== undefined)
          .sort(([fieldA], [fieldB]) => fieldA.localeCompare(fieldB)),
      ] as const)
      .filter(([, fields]) => fields.length > 0)
      .sort(([rowA], [rowB]) => rowA - rowB);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** WARN 5 (Sol audit round 3) — the rejectedLwinRows counterpart to
 * overridesSliceEqual above: an order-independent, dedup-aware comparison
 * of two row-number slices, for the identical "did this genuinely change"
 * retry gate. */
function numberSliceEqual(a: number[], b: number[]): boolean {
  const normalize = (rows: number[]) => Array.from(new Set(rows)).sort((x, y) => x - y);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** WARN 5 / BLOCK 2 (Sol audit round 3) — the approvedLwinRows counterpart
 * to overridesSliceEqual above: an order-independent comparison of two
 * (row number -> lwin_id) slices. */
function approvedSliceEqual(a: ApprovedLwinRows, b: ApprovedLwinRows): boolean {
  const normalize = (rec: ApprovedLwinRows) =>
    Object.entries(rec)
      .map(([rowNumber, lwinId]) => [Number(rowNumber), lwinId] as const)
      .sort(([rowA], [rowB]) => rowA - rowB);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** One row this chunk has full parsed text for — the chunk's own first
 * data row, or one of its error rows (see buildImportAnywayOverride's own
 * comment for why these are the only rows available without a heavier,
 * whole-chunk data-retention change). */
export type ImportAnywayGridRow = { rowNumber: number; rawText: Record<CanonicalHeader, string> };

export type ImportAnywayOutcome =
  | { ok: true; overridePatch: RowOverrides }
  /** Round-7 audit finding 2: the deterministic scheme's variation space
   * for THIS chunk is exhausted — gridSize non-empty cells were not
   * enough to give chunkIndex its own distinct subset. `gridSize` is
   * surfaced so the caller's guidance can be concrete. */
  | { ok: false; reason: "exhausted"; gridSize: number };

/** Round-6 audit finding 3, made distinct-per-chunk by round-7 audit
 * finding 2: the pure logic behind "Import anyway" — builds a canonical
 * no-op override from this chunk's own known rows (never a fabricated
 * value; every cell is a row's existing, already-parsed text).
 *
 * Round-6's version always picked the SAME single cell (chunk.startRow,
 * CANONICAL_HEADERS[0]) regardless of chunkIndex — so two identical
 * sibling chunks produced the IDENTICAL no-op override, which hashes to
 * the IDENTICAL namespaced content_sha256, which 23505s again exactly like
 * the original collision: clicking "Import anyway" a second time on the
 * second sibling was a dead end (Retry stays hidden — the regenerated
 * override slice equals sentOverridesSnapshot).
 *
 * The fix: enumerate every (row, non-blank-field) cell across this chunk's
 * KNOWN rows — its first data row (global row number = firstRow.rowNumber,
 * captured even for a fully-valid duplicate chunk with zero error rows —
 * see ChunkPreviewEntry.firstRowRawText's own comment in session-step.tsx)
 * plus every one of its OWN error rows (chunkedPreview.errorRows already
 * carries full rawText for these at no extra retention cost — this
 * deliberately does NOT require capturing every row of a
 * CLIENT_CHUNK_TARGET_ROWS-sized chunk, which would multiply this
 * feature's memory footprint by chunk size for no benefit: a fully valid
 * duplicate chunk's grid is necessarily just its first row's non-blank
 * fields, which is already enough headroom that exhausting it requires
 * more identical siblings than CANONICAL_HEADERS has fields — "absurd in
 * practice" is a deliberate, accepted bound, not an oversight). Rows are
 * deduped by rowNumber first (the first row CAN also be an error row), in
 * a fixed order — first row, then error rows in their given order — and
 * each row's fields are enumerated in CANONICAL_HEADERS order, skipping
 * any blank one (nothing to meaningfully "override" there).
 *
 * The resulting flat cell list has length `gridSize`. chunkIndex (always
 * >= 1, unique per chunk within a session) selects a subset by TAKING THE
 * FIRST chunkIndex CELLS — a trivially injective map from chunkIndex to a
 * distinct subset SIZE for every chunkIndex in [1, gridSize]: two
 * different chunkIndex values can never produce the same cell COUNT, and
 * canonicalizeRowOverrides (batch-service.ts) sorts its output by row then
 * field, so a different cell count is always a different canonicalized
 * JSON array length — never the same digest. Every value in the resulting
 * override is the row's OWN existing text (a content no-op, exactly as
 * before). When chunkIndex EXCEEDS gridSize, the scheme has run out of
 * distinct subsets for this chunk (chunkIndex would wrap onto a size
 * already used by some other chunk in [1, gridSize]) — reported as
 * `{ ok: false, reason: "exhausted" }` rather than silently generating an
 * override already known to collide again, exactly the round-6 dead end
 * this fix exists to close. Exported so the scheme can be pinned directly,
 * without exercising the full ImportClient component tree. */
export function buildImportAnywayOverride(
  chunkIndex: number,
  firstRow: ImportAnywayGridRow | null,
  errorRowsInChunk: ImportAnywayGridRow[],
): ImportAnywayOutcome | null {
  if (!firstRow) return null;

  const seenRows = new Set<number>();
  const gridRows: ImportAnywayGridRow[] = [];
  for (const row of [firstRow, ...errorRowsInChunk]) {
    if (seenRows.has(row.rowNumber)) continue;
    seenRows.add(row.rowNumber);
    gridRows.push(row);
  }

  const cells: { rowNumber: number; field: CanonicalHeader }[] = [];
  for (const row of gridRows) {
    for (const field of CANONICAL_HEADERS) {
      if (row.rawText[field]) cells.push({ rowNumber: row.rowNumber, field });
    }
  }

  const gridSize = cells.length;
  if (gridSize === 0 || chunkIndex > gridSize) {
    return { ok: false, reason: "exhausted", gridSize };
  }

  const subset = cells.slice(0, chunkIndex);
  const overridePatch: RowOverrides = {};
  for (const cell of subset) {
    const row = gridRows.find((r) => r.rowNumber === cell.rowNumber)!;
    overridePatch[cell.rowNumber] = { ...overridePatch[cell.rowNumber], [cell.field]: row.rawText[cell.field] };
  }

  return { ok: true, overridePatch };
}

export function ImportClient() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [conversionNotice, setConversionNotice] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; summary: PreviewSummary } | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Inline row-fix: rowNumber is GLOBAL (the number shown in the preview
  // UI) for both the plain and chunked paths — handleConfirmChunked
  // translates it back to each chunk's own local row numbers.
  const [rowOverrides, setRowOverrides] = useState<RowOverrides>({});
  // Item 2 (per-row LWIN match visibility/rejection): which matched rows
  // (GLOBAL row numbers, same convention as rowOverrides above) the
  // operator has rejected the LWIN match on.
  const [rejectedLwinRows, setRejectedLwinRows] = useState<RejectedLwinRows>(() => new Set());
  const onToggleLwinReject = useCallback((rowNumber: number) => {
    setRejectedLwinRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }, []);
  const onRowFieldChange = useCallback((rowNumber: number, field: CanonicalHeader, value: string) => {
    setRowOverrides((prev) => ({ ...prev, [rowNumber]: { ...prev[rowNumber], [field]: value } }));
  }, []);
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [recent, setRecent] = useState<BatchSummary[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chunked (> MAX_ROWS) path — untouched for the common small-file case.
  const [chunkedPlan, setChunkedPlan] = useState<ChunkedPlanState | null>(null);
  const [chunkedPreview, setChunkedPreview] = useState<ChunkedPreviewState | null>(null);
  const [chunkUpload, setChunkUpload] = useState<ChunkUploadState[] | null>(null);
  // BLOCK 1 (round-11 fix, was WARN 4 round-29 audit): the number of
  // preview/confirm "units" this file needs — a chunk count for a file
  // over MAX_ROWS, or 1 for a file that previews/confirms as a single
  // unit. estimateChunkedPhaseWaitSeconds(previewUnits) turns this into the
  // operator-facing wait estimate for ONE phase (preview OR confirm) of
  // THIS file. Computed by the effect below as soon as a file is selected —
  // BEFORE the operator ever clicks Preview, not merely before the network
  // call inside it — so a plain (<= MAX_ROWS) file gets the same advance
  // disclosure a chunked one already did, and neither path's warning
  // depends on the operator having already committed to the wait.
  //
  // BLOCK 1 (round-13 fix) — previewUnits alone can't distinguish "not
  // known yet for THIS file" from "known to be unavailable," and nothing
  // used to stop the operator from clicking Preview during that gap, or
  // from reading the PREVIOUS file's estimate while a new one was still
  // resolving (see countPreviewUnits' own comment and PreviewUnitsStatus
  // above). previewUnitsStatus tracks that explicitly.
  //
  // The stale value is cleared SYNCHRONOUSLY, DURING RENDER, the instant
  // `file` changes — React's own "adjusting state when a prop changes"
  // pattern (comparing against a ref-like previewUnitsFile state and
  // calling setState in the render body, not inside an effect): this is
  // what actually closes both races, since it happens before the browser
  // ever paints the old value, not merely "before the next effect flush."
  // Doing this inside a useEffect body instead (the more obvious spot)
  // trips `react-hooks/set-state-in-effect` — an unconditional setState
  // call in an effect causes an extra cascading render for no benefit
  // when the render-phase pattern achieves the same synchronous clear.
  // The actual async count still lives in its own effect below, which
  // only ever calls setState from its `.then()` callback (not the effect
  // body itself), which the same lint rule allows.
  const [previewUnits, setPreviewUnits] = useState<number | null>(null);
  const [previewUnitsStatus, setPreviewUnitsStatus] = useState<PreviewUnitsStatus>("idle");
  const [previewUnitsFile, setPreviewUnitsFile] = useState<File | null>(file);
  if (file !== previewUnitsFile) {
    setPreviewUnitsFile(file);
    setPreviewUnits(null);
    setPreviewUnitsStatus(file ? "pending" : "idle");
  }
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void countPreviewUnits(file).then((units) => {
      if (cancelled) return;
      setPreviewUnits(units);
      setPreviewUnitsStatus(units === null ? "unavailable" : "ready");
    });
    return () => {
      cancelled = true;
    };
  }, [file]);
  const [confirmingChunked, setConfirmingChunked] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionLabel, setSessionLabel] = useState<string>("cellar.csv");
  const requestTimestampsRef = useRef<number[]>([]);

  const loadRecent = useCallback(async () => {
    const response = await fetch("/api/import/batches", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load recent imports.");
    return (await response.json()) as { batches: BatchSummary[] };
  }, []);

  useEffect(() => {
    let active = true;
    loadRecent()
      .then((data) => {
        if (active) setRecent(data.batches);
      })
      .catch(() => {
        // Best-effort — the recent-imports list is a convenience, not load-bearing.
      });
    return () => {
      active = false;
    };
  }, [loadRecent]);

  // Resume: if a prior session is still in progress (per this browser's
  // localStorage), jump straight to its SessionStep — reconciled against
  // the server's own progress, never trusted on its own.
  //
  // Round-6 audit finding 4(b): a session with a client-side-skipped chunk
  // (SessionStep's own comment) can NEVER derive status='completed'
  // (getImportSessionProgress, session-service.ts) — it stays "in_progress"
  // on the server forever. VERIFIED every other reader of this status,
  // grepping across src/ for every place progress.status (or the raw
  // import_sessions.status column) is read:
  //   - THIS effect: the early return above only fires for "reverted"/
  //     "completed", so a permanently-"in_progress" session keeps landing
  //     the operator back on its own SessionStep on every reload — until
  //     they explicitly click "Start a new import" (writeStoredSession(null),
  //     the SessionStep/BatchStep onDone handlers below).
  //   - SessionStep's own status pill (session-step.tsx): renders "In
  //     progress" forever instead of "Completed" — a cosmetic difference
  //     only, not a functional gate.
  //   - SessionStep's pending-resolution and revert-button gates
  //     (`progress.status !== "reverted"`): both treat "in_progress" and
  //     "completed" IDENTICALLY — a stuck-at-in_progress session behaves
  //     exactly like a completed one for apply/resolve/revert.
  //   - No cron/cleanup job, no other UI surface, and no other file reads
  //     this status at all. A permanently in_progress session is therefore
  //     benign everywhere: at worst a stale status LABEL and a reload that
  //     returns you to the same place, never a hard error, a blocked
  //     action, or a resource leak.
  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) return;
    let active = true;
    (async () => {
      try {
        const response = await fetch(`/api/import/sessions/${stored.sessionId}`, { cache: "no-store" });
        if (!response.ok) {
          writeStoredSession(null);
          return;
        }
        const progress = (await response.json()) as { status: string };
        if (!active) return;
        if (progress.status === "reverted" || progress.status === "completed") {
          // Nothing left to resume — never re-jump into a finished session.
          writeStoredSession(null);
          return;
        }
        setSessionId(stored.sessionId);
        setSessionLabel(stored.label);
        setStep("session");
      } catch {
        // best-effort — resume is a convenience, never load-bearing.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const runSingleFilePreview = useCallback(async (selectedFile: File) => {
    const form = new FormData();
    form.append("file", selectedFile);
    const response = await fetch("/api/import/preview", { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok) {
      setPreviewError(body?.error?.message ?? "Preview failed.");
      setPreview(null);
      return;
    }
    setPreview(body);
    setChunkedPlan(null);
    setChunkedPreview(null);
    setStep("preview");
  }, []);

  const runChunkedPreview = useCallback(
    async (selectedFile: File, headerRecord: string, dataRecords: string[], bytes: Uint8Array) => {
      const result = await planChunkedPreview(selectedFile, headerRecord, dataRecords, bytes);
      if (!result.ok) {
        setPreviewError(result.error);
        return;
      }
      setChunkedPlan(result.plan);
      setChunkedPreview(result.preview);
      setChunkUpload(null);
      setSessionId(null);
      setPreview(null);
      setStep("preview");
    },
    [],
  );

  const handlePreview = useCallback(async () => {
    if (!file) return;
    setPreviewing(true);
    setPreviewError(null);
    setRowOverrides({});
    setRejectedLwinRows(new Set());
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let text: string;
      try {
        text = decodeCsvBytesStrict(bytes);
      } catch (err) {
        setPreviewError(err instanceof UnsupportedEncodingError ? err.message : "Could not read this CSV file.");
        return;
      }

      let allRecords: string[];
      try {
        allRecords = splitLogicalRecords(text);
      } catch (err) {
        setPreviewError(
          err instanceof AmbiguousRecordSplitError || err instanceof UnsupportedLineEndingError
            ? err.message
            : "Could not read this CSV file.",
        );
        return;
      }
      if (allRecords.length === 0) {
        setPreviewError("File is empty.");
        return;
      }

      // BLOCK 1 (round-11 fix): the operator's wait estimate (previewUnits,
      // shown by UploadStep) was already computed by countPreviewUnits when
      // this file was selected — nothing to (re)set here.
      const [headerRecord, ...dataRecords] = allRecords;
      if (dataRecords.length <= MAX_ROWS) {
        await runSingleFilePreview(file);
      } else {
        await runChunkedPreview(file, headerRecord, dataRecords, bytes);
      }
    } catch {
      setPreviewError("Preview failed. Check your connection and try again.");
    } finally {
      setPreviewing(false);
    }
  }, [file, runSingleFilePreview, runChunkedPreview]);

  const handleConfirm = useCallback(async () => {
    if (!file) return;
    setConfirming(true);
    try {
      const form = new FormData();
      form.append("file", file);
      if (Object.keys(rowOverrides).length > 0) {
        form.append("rowOverrides", JSON.stringify(rowOverrides));
      }
      if (rejectedLwinRows.size > 0) {
        form.append("rejectedLwinRows", JSON.stringify(Array.from(rejectedLwinRows)));
      }
      // BLOCK 2 (Sol audit round 3, finding 2): echo back the lwin_id
      // shown for every currently-linking matched row, so confirm's own
      // re-match can veto a disagreeing catalogue tie instead of silently
      // persisting it — see buildApprovedLwinRows' own comment.
      //
      // BLOCK 1 (round 5 fix): ALWAYS send this field, even as `{}` for a
      // file with zero linking matches — its mere PRESENCE tells confirm
      // this client showed the operator its full linking picture, so
      // applyLwinApprovalVeto (batch-service.ts) can fail closed on any
      // row absent from it. Gating this on non-emptiness (the old
      // behavior) made an all-non-linking file's confirm indistinguishable
      // from an older client that never sends this at all — exactly the
      // ambiguity that let a row re-scoring above the apply threshold
      // between preview and confirm sail through unvetoed.
      if (preview) {
        const approvedLwinRows = buildApprovedLwinRows(matchedRowsFromPreviewRows(preview.rows));
        form.append("approvedLwinRows", JSON.stringify(approvedLwinRows));
      }
      const response = await fetch("/api/import/batches", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        // Round-27 audit (removes the in-preview conflict-recovery panel):
        // the server's own message is the only guidance shown for a
        // conflict — no client-side escalation, no invented terminal state.
        // A multiple_live_batches conflict or a duplicate_race_retry stays
        // retryable exactly like any other failure; recovery for the
        // former is through Recent imports.
        const message: string = body?.error?.message ?? "Import could not be created.";
        setPreviewError(message);
        return;
      }
      await loadBatchDetail(body.batchId, setBatch);
      setStep("batch");
      void loadRecent();
    } catch {
      setPreviewError("Import could not be created. Check your connection and try again.");
    } finally {
      setConfirming(false);
    }
  }, [file, preview, rowOverrides, rejectedLwinRows, loadRecent]);

  /** Skips any chunk `chunkUpload` already marks "confirmed" — the
   * retry-after-failure path reruns confirmChunkedSession (via
   * confirmChunkedSessionWithResume, round-6 audit finding 4(c)) with the
   * prior chunkUpload state as initialUpload, so only the failed/unsent
   * chunks are actually re-sent. See session-step.tsx for the sequential
   * driver itself, and confirmChunkedSessionWithResume's own comment for
   * why a cross-session conflict now RETRIES instead of hard-stopping. */
  const handleConfirmChunked = useCallback(async () => {
    if (!chunkedPlan) return;
    setConfirmingChunked(true);
    setPreviewError(null);
    try {
      const initial: ChunkUploadState[] =
        chunkUpload ??
        chunkedPlan.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null }));

      const result = await confirmChunkedSessionWithResume({
        plan: chunkedPlan,
        initialUpload: initial,
        existingSessionId: sessionId,
        fileLabel: file?.name ?? sessionLabel,
        timestampsRef: requestTimestampsRef,
        rowOverrides,
        rejectedLwinRows,
        // BLOCK 2 (Sol audit round 3, finding 2): same reasoning as
        // handleConfirm's own approvedLwinRows — echo back the lwin_id
        // shown for every currently-linking matched row across every
        // chunk, from the aggregated chunked preview's own matchedRows.
        approvedLwinRows: buildApprovedLwinRows(chunkedPreview?.matchedRows ?? []),
        onSessionId: (id) => {
          setSessionId(id);
          setSessionLabel(file?.name ?? sessionLabel);
        },
        onProgress: setChunkUpload,
      });

      if (!result.ok) {
        setPreviewError(result.error);
        return;
      }
      setStep("session");
      void loadRecent();
    } catch {
      setPreviewError("Import could not be created. Check your connection and try again.");
    } finally {
      setConfirmingChunked(false);
    }
  }, [chunkedPlan, chunkUpload, sessionId, file, sessionLabel, rowOverrides, rejectedLwinRows, chunkedPreview, loadRecent]);

  const isRowLocked = useCallback(
    (rowNumber: number) => isRowInConfirmedChunk(rowNumber, chunkedPlan, chunkUpload),
    [chunkedPlan, chunkUpload],
  );
  // Round-6 audit finding 5: the skipped-chunk counterpart — see
  // isRowInSkippedChunk's own comment for why it's a separate predicate.
  const isRowSkipped = useCallback(
    (rowNumber: number) => isRowInSkippedChunk(rowNumber, chunkedPlan, chunkUpload),
    [chunkedPlan, chunkUpload],
  );

  const handleSkipChunk = useCallback((index: number) => {
    setChunkUpload((prev) => skipChunk(prev ?? [], index));
  }, []);

  const handleUndoSkip = useCallback((index: number) => {
    setChunkUpload((prev) => undoSkipChunk(prev ?? [], index));
  }, []);

  /** Round-6 audit finding 3, made distinct-per-chunk by round-7 audit
   * finding 2: "Import anyway" for a chunk stuck on duplicate_chunk_content
   * — deterministically generates a canonical no-op override, DISTINCT per
   * chunkIndex, so the confirm's content_sha256 is namespaced away from
   * the sibling it collided with (round-6's version always picked the
   * SAME cell regardless of chunkIndex, so a SECOND identical sibling's
   * "Import anyway" click regenerated the identical, still-colliding
   * override — a dead end this now avoids). Uses buildImportAnywayOverride
   * (below) for the actual, testable logic; when its variation space for
   * this chunk is exhausted (round-7 finding 2 — more identical siblings
   * than this chunk has distinct non-blank cells, "absurd in practice"),
   * surfaces guidance toward Skip or a single-file import instead of
   * silently generating an override already known to collide again. */
  const handleImportAnyway = useCallback(
    (chunkIndex: number) => {
      const chunkEntry = chunkedPreview?.perChunk.find((c) => c.index === chunkIndex);
      const firstRow =
        chunkEntry && chunkEntry.firstRowRawText
          ? { rowNumber: chunkEntry.startRow, rawText: chunkEntry.firstRowRawText }
          : null;
      const errorRowsInChunk = (chunkedPreview?.errorRows ?? [])
        .filter((row) => row.chunkIndex === chunkIndex)
        .map((row) => ({ rowNumber: row.rowNumber, rawText: row.rawText }));
      const outcome = buildImportAnywayOverride(chunkIndex, firstRow, errorRowsInChunk);
      if (!outcome) return;
      if (!outcome.ok) {
        setPreviewError(
          `Chunk ${chunkIndex} has run out of distinct "Import anyway" variations for this file — use ` +
            '"Skip this chunk" instead, or import this segment as its own single-file upload.',
        );
        return;
      }
      setRowOverrides((prev) => {
        const next = { ...prev };
        for (const [key, fields] of Object.entries(outcome.overridePatch)) {
          next[Number(key)] = { ...next[Number(key)], ...fields };
        }
        return next;
      });
    },
    [chunkedPreview],
  );

  /** A spreadsheet is converted to CSV the moment it is chosen, server-side
   * (the xlsx reader is far too heavy to ship to the browser). From that point
   * on the file IS a CSV: record splitting, chunk planning, preview and
   * confirm all run on the converted text exactly as they would on an uploaded
   * .csv, so nothing downstream needs to know a workbook was ever involved. */
  const handleFileSelected = useCallback(async (selected: File | null) => {
    setConversionNotice(null);
    setPreviewError(null);

    if (!selected) {
      setFile(null);
      return;
    }
    if (!isSpreadsheetFile(selected)) {
      setFile(selected);
      return;
    }

    // Clear any previously-selected file first: if the conversion fails there
    // must be no stale file left sitting behind the error, ready to be
    // previewed as though it were the one just chosen.
    setFile(null);
    setConverting(true);
    try {
      const outcome = await convertSpreadsheetFile(selected);
      if (!outcome.ok) {
        setPreviewError(outcome.message);
        return;
      }
      setFile(outcome.file);
      setConversionNotice(outcome.notice);
    } finally {
      setConverting(false);
    }
  }, []);

  // A spreadsheet chosen on the scan screen was parked for us on the way here.
  // Pick it up and treat it exactly as if it had been chosen on this screen.
  // takeHandoffFile is single-consumption, so React's development double-invoke
  // of this effect cannot import the same file twice.
  useEffect(() => {
    const handedOff = takeHandoffFile();
    if (!handedOff) return;
    // Deferred into a promise callback rather than called straight from the
    // effect body: handleFileSelected sets state synchronously before its first
    // await, and `react-hooks/set-state-in-effect` (rightly) rejects that in an
    // effect body while allowing it from an async continuation — the same
    // pattern the preview-unit counter below already follows.
    void Promise.resolve().then(() => handleFileSelected(handedOff));
  }, [handleFileSelected]);

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setConversionNotice(null);
    setConverting(false);
    setPreview(null);
    setPreviewError(null);
    setBatch(null);
    setChunkedPlan(null);
    setChunkedPreview(null);
    setChunkUpload(null);
    setSessionId(null);
    setSessionLabel("cellar.csv");
    setRowOverrides({});
    setRejectedLwinRows(new Set());
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  return (
    <div className="mx-auto max-w-[640px] px-md py-lg">
      <header className="mb-lg">
        <h1 className="font-serif text-[28px] font-normal leading-tight text-ink">Import cellar</h1>
        <p className="mt-2xs text-[14px] text-grey">
          Upload a CSV or Excel (.xlsx) file of your existing inventory. Nothing is written to your cellar until you confirm the preview.
        </p>
      </header>

      {step === "upload" && (
        <UploadStep
          file={file}
          setFile={handleFileSelected}
          converting={converting}
          conversionNotice={conversionNotice}
          fileInputRef={fileInputRef}
          onPreview={handlePreview}
          previewing={previewing}
          previewUnits={previewUnits}
          previewUnitsStatus={previewUnitsStatus}
          error={previewError}
        />
      )}

      {step === "preview" && (preview || chunkedPreview) && (
        <PreviewStep
          filename={file?.name ?? "cellar.csv"}
          summary={chunkedPreview?.summary ?? preview?.summary ?? ZERO_SUMMARY}
          errorRows={
            chunkedPreview?.errorRows ??
            (preview?.rows
              .filter((r) => r.rowState === "error")
              .map((r) => ({ rowNumber: r.rowNumber, errors: r.errors, rawText: r.rawText })) ?? [])
          }
          matchedRows={chunkedPreview?.matchedRows ?? (preview ? matchedRowsFromPreviewRows(preview.rows) : [])}
          rejectedLwinRows={rejectedLwinRows}
          onToggleLwinReject={onToggleLwinReject}
          rowOverrides={rowOverrides}
          onRowFieldChange={onRowFieldChange}
          isRowLocked={isRowLocked}
          isRowSkipped={isRowSkipped}
          chunkBreakdown={chunkedPreview?.perChunk}
          chunkTotal={chunkedPlan?.chunkTotal}
          chunkUpload={chunkUpload}
          onSkipChunk={chunkedPreview ? handleSkipChunk : undefined}
          onImportAnyway={chunkedPreview ? handleImportAnyway : undefined}
          onUndoSkip={chunkedPreview ? handleUndoSkip : undefined}
          onConfirm={chunkedPreview ? () => void handleConfirmChunked() : () => void handleConfirm()}
          confirming={chunkedPreview ? confirmingChunked : confirming}
          onBack={reset}
          error={previewError}
        />
      )}

      {step === "batch" && batch && (
        <BatchStep batch={batch} setBatch={setBatch} onDone={() => { reset(); void loadRecent(); }} />
      )}

      {step === "session" && sessionId && (
        <SessionStep
          sessionId={sessionId}
          label={sessionLabel}
          skippedChunks={
            chunkUpload
              ?.filter((c) => c.status === "skipped")
              .map((c) => ({ index: c.index, duplicateOfChunkIndex: c.duplicateOfChunkIndex })) ?? []
          }
          onDone={() => {
            writeStoredSession(null);
            reset();
            void loadRecent();
          }}
        />
      )}

      <RecentImports batches={recent} onOpen={async (id) => {
        await loadBatchDetail(id, setBatch);
        setStep("batch");
      }} />
    </div>
  );
}

async function loadBatchDetail(id: string, setBatch: (b: BatchDetail) => void) {
  const response = await fetch(`/api/import/batches/${id}`, { cache: "no-store" });
  if (!response.ok) return;
  setBatch(await response.json());
}

/** WARN 4 (round-29 audit) — plain-language rendering of an ESTIMATED
 * seconds figure (estimateChunkedPhaseWaitSeconds, session-step.tsx) for
 * the operator-facing cost messages below. Minutes past 90s, otherwise
 * seconds — never false precision.
 *
 * NIT 4 (round-13 fix) — CORRECTED wording: this used to call the input "a
 * worst-case bound." It isn't one — see estimateChunkedPhaseWaitSeconds'
 * own comment (session-step.tsx) for why nothing actually enforces it as a
 * cap. This is a measured duration ONLY in the sense that it's derived
 * from a real (if inherited) benchmark, never a guarantee about any one
 * run. */
function formatRoughDuration(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Round-11 fix (BLOCK 1) — wording for the operator-facing wait estimate.
 * The old copy ("up to Xs in the worst case") stated more certainty than
 * the numbers behind it actually have: LWIN_MATCH_PER_CALL_SECONDS
 * (constants.ts) is an INHERITED estimate from a different measurement run,
 * not a reproduced one, and matchLwinBulk (lwin-matching.ts) awaits its RPC
 * calls with no elapsed-time deadline of its own, so nothing actually
 * enforces this number as a cap. Worded here as the approximation it is.
 *
 * BLOCK 2 / NIT 4 (round-13 fix) — this used to also carve out "it doesn't
 * include the brief catalog name lookup that runs afterward": preview used
 * to make a SECOND network call (a separate lwin_catalog display-name
 * lookup) after matching, uncounted by this estimate. That lookup is
 * deleted outright — match_lwin_bulk already returns display_name, so
 * matching is genuinely the only network call this estimate needs to
 * cover, and the carve-out is gone with it. */
function describeWaitEstimate(seconds: number): string {
  return (
    `approximately ${formatRoughDuration(seconds)} for wine-catalog matching — an estimate from measured ` +
    `matching performance, not a guaranteed cap`
  );
}

function UploadStep({
  file,
  setFile,
  converting,
  conversionNotice,
  fileInputRef,
  onPreview,
  previewing,
  previewUnits,
  previewUnitsStatus,
  error,
}: {
  file: File | null;
  setFile: (f: File | null) => void;
  /** True while a chosen .xlsx is being converted to CSV server-side. */
  converting: boolean;
  /** What the conversion read, once it succeeds — which sheet, how many rows.
   * A workbook can hold several sheets and only the first is imported, so the
   * operator is told which one they are about to preview. */
  conversionNotice: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPreview: () => void;
  previewing: boolean;
  /** BLOCK 1 (round-11 fix): the preview/confirm unit count
   * (countPreviewUnits) for the currently-selected file — 1 for a plain
   * file, a chunk count for one over MAX_ROWS, or null before it's known
   * (no file selected yet, or the file couldn't even be decoded/split).
   * Drives the wait estimate below on BOTH paths, shown as soon as it's
   * known — before the operator ever clicks Preview, not only once
   * "previewing" is already true. */
  previewUnits: number | null;
  /** BLOCK 1 (round-13 fix): whether previewUnits (above) reflects the
   * CURRENTLY selected file yet — see PreviewUnitsStatus's own comment.
   * Gates the Preview button below so a click can't land in the window
   * before the estimate resolves, or while a stale previous-file estimate
   * is still on screen mid-swap. */
  previewUnitsStatus: PreviewUnitsStatus;
  error: string | null;
}) {
  return (
    <div className="rounded-card card-surface p-lg">
      <label
        htmlFor="import-file"
        className="flex min-h-11 cursor-pointer flex-col items-center justify-center gap-sm rounded-card border-2 border-dashed border-beige-deep bg-bridge-surface px-lg py-xl text-center transition-colors hover:border-accent hover:bg-blush-wash/40 focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/25"
      >
        <input
          ref={fileInputRef}
          id="import-file"
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white">
          <Upload className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="text-[14px] font-medium text-ink">
          {converting ? "Reading spreadsheet…" : file ? file.name : "Choose a CSV or Excel file"}
        </span>
        <span className="text-caption text-grey">
          .csv or .xlsx up to 5 MB per upload — larger files split into {CLIENT_CHUNK_TARGET_ROWS}-row chunks automatically
        </span>
      </label>

      {conversionNotice && (
        <p className="mt-md text-[13px] text-grey">{conversionNotice}</p>
      )}

      {error && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-accent">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {/* BLOCK 1 (round-11 fix, was WARN 4 round-29 audit): shown as soon as
          previewUnits is known — BEFORE the operator clicks Preview, on
          every file (single-unit or multi-chunk), not only a chunked one
          and not only once "previewing" is already true. A multi-chunk
          file is previewed one chunk at a time, so this is the total for
          the whole (sequential) phase, not any one chunk's own budget. */}
      {previewUnits !== null && (
        <p className="mt-md text-[13px] text-grey">
          {previewUnits > 1
            ? `This file needs ${previewUnits} chunks, uploaded one at a time — previewing it is estimated to take `
            : "Previewing this file is estimated to take "}
          up to {describeWaitEstimate(estimateChunkedPhaseWaitSeconds(previewUnits))}.
          {previewUnits > 1 ? " Confirming afterward repeats a similar, chunk-by-chunk process." : ""}
        </p>
      )}

      <button
        type="button"
        // BLOCK 1 (round-13 fix): disabled while previewUnitsStatus is
        // "pending" — the window where this file's own estimate hasn't
        // resolved yet (either it was just selected, or a different file
        // was just swapped in and this one's async count is still in
        // flight). "unavailable" still allows a click: handlePreview's own
        // real decode/split will surface the actual error.
        // `converting` is belt-and-braces: the conversion path clears `file`
        // first, so `!file` already covers it — but the guard must not depend on
        // that ordering staying true.
        disabled={!file || converting || previewing || previewUnitsStatus === "pending"}
        onClick={onPreview}
        className="mt-lg flex min-h-11 w-full items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {previewing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {previewing ? "Reading file…" : "Preview import"}
      </button>

      <a
        href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`}
        download="cellar-import-template.csv"
        className="mt-md flex min-h-11 items-center justify-center text-[13px] font-medium text-ink-muted underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
      >
        Download CSV template
      </a>
    </div>
  );
}

/** Renders either the plain (<= MAX_ROWS) preview or the aggregated,
 * chunked (> MAX_ROWS) preview — chunkBreakdown/chunkTotal/chunkUpload are
 * only ever set for the latter. Exported so it can be pinned directly by
 * import-client.test.tsx (locked-row rendering, the honest chunk/data-row
 * label, incremental error-row disclosure, and the chunk_content_mismatch
 * terminal state — Sol round-2 audit findings 1, 3, 4, 5). */
export function PreviewStep({
  filename,
  summary,
  errorRows,
  matchedRows,
  rejectedLwinRows,
  onToggleLwinReject,
  rowOverrides,
  onRowFieldChange,
  isRowLocked,
  isRowSkipped,
  chunkBreakdown,
  chunkTotal,
  chunkUpload,
  onSkipChunk,
  onImportAnyway,
  onUndoSkip,
  onConfirm,
  confirming,
  onBack,
  error,
}: {
  filename: string;
  summary: PreviewSummary;
  errorRows: ErrorRowEntry[];
  /** Item 2 (per-row LWIN match visibility): every matched row, so the
   * operator can see WHAT matched (not just that it did) and reject a
   * match they don't trust. Optional (defaults to none shown) so every
   * pre-existing caller/test that doesn't know about this feature keeps
   * working unchanged — mirrors isRowSkipped's own optionality above. */
  matchedRows?: MatchedLwinRowEntry[];
  rejectedLwinRows?: RejectedLwinRows;
  onToggleLwinReject?: (rowNumber: number) => void;
  rowOverrides: RowOverrides;
  onRowFieldChange: (rowNumber: number, field: CanonicalHeader, value: string) => void;
  /** Sol round-2 audit finding 1: true for a row whose chunk is already
   * confirmed — its inline-fix inputs render read-only. Always returns
   * false on the plain (non-chunked) path. */
  isRowLocked: (rowNumber: number) => boolean;
  /** Round-6 audit finding 5: true for a row whose chunk has been
   * client-side skipped — see isRowInSkippedChunk's own comment. Optional
   * (defaults to "never skipped") so every pre-existing caller/test that
   * doesn't know about skip keeps working unchanged. */
  isRowSkipped?: (rowNumber: number) => boolean;
  chunkBreakdown?: { index: number; startRow: number; endRow: number; summary: PreviewSummary }[];
  chunkTotal?: number;
  chunkUpload: ChunkUploadState[] | null;
  /** Round-5 audit finding 4: "Skip this chunk" for a duplicate_chunk_content
   * chunk — see ChunkUploadProgress's own comment. Omitted on the plain
   * (non-chunked) path, where the concept doesn't apply. */
  onSkipChunk?: (index: number) => void;
  /** Round-6 audit finding 3: "Import anyway" for a duplicate_chunk_content
   * chunk — see ChunkUploadProgress's own comment. Omitted on the plain
   * (non-chunked) path. */
  onImportAnyway?: (index: number) => void;
  /** Round-6 audit finding 5: restores a skipped chunk to its failed
   * duplicate_chunk_content state, with both actions available again.
   * Omitted on the plain (non-chunked) path. */
  onUndoSkip?: (index: number) => void;
  onConfirm: () => void;
  confirming: boolean;
  onBack: () => void;
  /** The server's own message for the most recent failure — including a
   * multiple_live_batches or duplicate_race_retry conflict. This is the
   * ONLY guidance this panel shows for a conflict (round-27 audit — see
   * docs/runbooks/csv-import.md): no separate standing instruction, no
   * client-invented terminal state. Recovery for multiple_live_batches is
   * through Recent imports, which lists every non-reverted batch. */
  error: string | null;
}) {
  // Sol round-2 audit (2026-08-27) finding 4: incremental disclosure
  // instead of a hard cap — starts at MAX_SHOWN_ERROR_ROWS and grows by
  // the same page size each time "Show more" is clicked, repeatable
  // until every error row is shown. Safe as plain useState: PreviewStep
  // unmounts (step leaves "preview") before a genuinely new errorRows
  // list can ever replace this one, so there's no stale-count case to
  // reset for.
  const [shownCount, setShownCount] = useState(MAX_SHOWN_ERROR_ROWS);
  // Item 2: same incremental-disclosure pattern, for matchedRows.
  const effectiveMatchedRows = matchedRows ?? EMPTY_MATCHED_ROWS;
  const effectiveRejectedLwinRows = rejectedLwinRows ?? EMPTY_REJECTED_LWIN_ROWS;
  // BLOCK 3 (Sol audit round 3, finding 3): preview classifies a match at
  // score >= LWIN_MATCH_THRESHOLD (0.3, constants.ts), but apply only
  // stamps wines.lwin_id at score >= LWIN_APPLY_MIN_SCORE (0.6,
  // 0108_apply_import_batch_chunk_v2.sql) — a row below that bar imports
  // with no catalog link no matter what the operator does with it. Split
  // here so "Matched wines" only ever claims rows that will actually
  // link, and a sub-threshold candidate gets its own honestly-labeled band
  // instead of a reject control that would do nothing.
  //
  // BLOCK 2 (round-13 fix) — an apply-eligible row (score >=
  // LWIN_APPLY_MIN_SCORE) with no display identity (lwinDisplayName ===
  // null) is EXCLUDED from linkingMatchedRows too, not just from
  // buildApprovedLwinRows' own payload: the operator can't verify a match
  // they're never shown, so it's treated as not-shown entirely — it never
  // renders under "Matched wines" (would wrongly imply it links) and never
  // renders under "Below match threshold" either (its score genuinely
  // clears that bar, so that band's own copy — "will import with no
  // catalog link" — would be a lie). Same condition buildApprovedLwinRows
  // gates on, so a row that isn't shown here is never approved either.
  const linkingMatchedRows = effectiveMatchedRows.filter(
    (r) => r.lwinScore >= LWIN_APPLY_MIN_SCORE && r.lwinDisplayName !== null,
  );
  const belowThresholdMatchedRows = effectiveMatchedRows.filter((r) => r.lwinScore < LWIN_APPLY_MIN_SCORE);
  const [shownMatchedCount, setShownMatchedCount] = useState(MAX_SHOWN_MATCHED_ROWS);
  const shownMatchedRows = linkingMatchedRows.slice(0, shownMatchedCount);
  const hiddenMatchedCount = linkingMatchedRows.length - shownMatchedRows.length;
  const [shownBelowThresholdCount, setShownBelowThresholdCount] = useState(MAX_SHOWN_MATCHED_ROWS);
  const shownBelowThresholdRows = belowThresholdMatchedRows.slice(0, shownBelowThresholdCount);
  const hiddenBelowThresholdCount = belowThresholdMatchedRows.length - shownBelowThresholdRows.length;
  const shownErrorRows = errorRows.slice(0, shownCount);
  const hiddenCount = errorRows.length - shownErrorRows.length;
  // A row the operator has edited into passing validation counts toward
  // "ready to confirm" too, even though summary (computed server-side
  // from the ORIGINAL file) has no way to know about it yet — confirm
  // re-validates every row server-side regardless, this only gates the
  // button.
  //
  // Sol round-3 audit (2026-08-27) finding 5: computed over the FULL
  // errorRows list (not just the currently-shown page) so the effective
  // counts below never undercount a fix made on an earlier page before
  // "Show more" was clicked — an override can only exist for a row that
  // was rendered at some point, and shownCount only ever grows (see this
  // component's own comment on `shownCount`), so every fixed row is
  // already included regardless of the current disclosure page.
  //
  // Round-6 audit finding 5: a row belonging to a SKIPPED chunk is
  // excluded here even if its override would otherwise validate — that
  // chunk's rows were never sent, and never will be, so counting a
  // client-side "fix" toward "Passing validation"/the "row(s) fixed"
  // caption below would inflate what's actually going to import.
  const fixedRowNumbers = new Set(
    errorRows
      .filter((row) => !isRowSkipped?.(row.rowNumber))
      .filter((row) => validateFields({ ...row.rawText, ...rowOverrides[row.rowNumber] }).state === "valid")
      .map((row) => row.rowNumber),
  );
  const fixedCount = fixedRowNumbers.size;
  const canConfirm = summary.validRows > 0 || fixedCount > 0;
  // finding 5: the summary stat tiles below used to render `summary`
  // verbatim — the ORIGINAL server-computed counts, frozen at preview
  // time — so fixing the file's only rejected row still said "Ready to
  // apply: 0, Errors (excluded): 1" even after the row visibly turned
  // "Fixed" and its own copy claimed it would be imported. These are an
  // honest CLIENT-SIDE projection of the same live re-validation
  // RowFixItem already runs, not a claim that the server has re-checked
  // anything yet — confirm always re-validates every row server-side
  // regardless of what's shown here.
  //
  // Round-4 audit finding 3: "Ready to apply" overstated what this number
  // means — a row that passes client-side validateFields can still land
  // in the server's pending bucket (unmatched LWIN, missing cost) or
  // merge into a duplicate at confirm time, so it was never actually
  // guaranteed to "apply." Relabeled to "Passing validation" (see the
  // stat tile below) with an always-visible caption stating plainly that
  // the server decides the final ready/needs-resolution split at import.
  //
  // Round-5 audit finding 5: the VALUE here used to be summary.readyToApplyRows
  // (rows with resolution === 'auto' — schema-valid AND already
  // auto-resolvable) even though the LABEL claims "Passing validation" —
  // so a schema-valid-but-unmatched wine (needs LWIN/cost resolution)
  // counted toward neither tile: "Passing validation: 0, Needs resolution:
  // 1" for a file with exactly one perfectly valid row. Fixed to derive
  // from summary.validRows (every schema-valid row, matching the label's
  // actual claim) plus locally-fixed rows — "Needs resolution" stays its
  // own separate line below, unaffected.
  //
  // Round-7 audit finding 5: summary.validRows is the aggregate across the
  // WHOLE file, computed once at preview time — it has no way to know a
  // chunk was later client-side skipped. A skipped chunk's rows are never
  // sent (isRowInSkippedChunk's own comment) and never will be, so its
  // originally-valid rows must be subtracted out here too, exactly like a
  // skipped chunk's rows are already excluded from fixedRowNumbers above —
  // otherwise "Passing validation" overstates what actually imports by
  // exactly the size of every skipped chunk. chunkBreakdown carries each
  // chunk's own PER-CHUNK PreviewSummary (validRows included) from the
  // same aggregation summary itself was built from, so this is the SAME
  // per-chunk source, not a re-derivation. Undo skip needs no separate
  // handling: this is a live re-derivation from the CURRENT chunkUpload
  // state on every render, so a chunk leaving "skipped" (handleUndoSkip)
  // simply drops out of this sum on the next render, restoring the count.
  const skippedValidRowCount = (chunkUpload ?? [])
    .filter((c) => c.status === "skipped")
    .reduce((sum, c) => sum + (chunkBreakdown?.find((cb) => cb.index === c.index)?.summary.validRows ?? 0), 0);
  const effectivePassingValidationRows = summary.validRows + fixedCount - skippedValidRowCount;
  const effectiveErrorRows = summary.errorRows - fixedCount;
  const hasFailedChunk = chunkUpload?.some((c) => c.status === "failed") ?? false;
  // Sol round-2 audit finding 3: chunk_content_mismatch is TERMINAL —
  // retrying re-sends this exact chunk's content and fails the same way
  // every time, and there is no fix reachable from inside this UI (the
  // conflict is with a DIFFERENT already-confirmed chunk, resolved only by
  // reverting it elsewhere). Never offer "Retry upload" for it; the
  // server's own message (surfaced via `error` above) already explains
  // the revert path.
  const hasChunkContentMismatch = chunkUpload?.some((c) => c.status === "failed" && c.code === "chunk_content_mismatch") ?? false;
  // Round-27 audit (removes the in-preview conflict-recovery panel, which
  // failed five straight audits — see docs/runbooks/csv-import.md):
  // multiple_live_batches and duplicate_race_retry no longer block
  // Confirm/Retry, and neither invents a terminal state after repeated
  // attempts. The server re-evaluates on every confirm attempt regardless
  // of what happened before, so a retry that changes nothing simply
  // re-raises the same conflict with fresh data, harmless and repeatable —
  // recovery for multiple_live_batches is through Recent imports, which no
  // longer hides an aged-out batch. Only chunk_content_mismatch and
  // duplicate_chunk_content stay terminal here — both have no fix a blind
  // retry could ever produce, unlike these two.
  // Round-4 audit finding 2: duplicate_chunk_content is also terminal by
  // default — no "Retry upload" — since a blind retry re-sends the exact
  // same bytes and 23505s the same way every time. UNLIKE
  // chunk_content_mismatch, though, it has a real fix reachable from
  // inside this same UI: this chunk's rows are still editable (isRowLocked
  // only locks a CONFIRMED chunk's rows, and this one is 'failed'), and
  // any rowOverride namespaces the chunk's content_sha256 so it no longer
  // collides with its sibling (the same-session exclusion in
  // findLiveBatchByUnderlyingFile then keeps the sibling from
  // short-circuiting the retry as a false duplicate).
  //
  // Round-5 audit finding 3: the gate used to check only that an override
  // EXISTS for one of this chunk's own rows — but two identical chunks
  // given the exact same inline fix hash identically every time (same
  // canonical overrides JSON -> same namespaced digest), so "an override
  // exists" never stops being true once the operator edits a field once,
  // and Retry would resend the same doomed digest forever. The gate now
  // compares the CURRENT override slice for this chunk's rows against the
  // slice that was actually SENT with the failed attempt
  // (ChunkUploadState.sentOverridesSnapshot, captured in
  // session-step.tsx) — only a slice that has genuinely CHANGED can
  // plausibly produce a different digest and resolve the collision.
  //
  // Round-6 audit finding 3: the slice used to be built by filtering
  // errorRows down to this chunk's own — which MISSES an override on a
  // row that isn't an error row at all, exactly what "Import anyway"
  // produces for a fully-valid duplicate chunk (its no-op override targets
  // the chunk's first data row, which has no error and so never appears in
  // errorRows). Rebuilt from chunkBreakdown's own [startRow, endRow] range
  // for this chunk instead — every override that actually belongs to this
  // chunk, whether or not its row happens to be an error row.
  // WARN 5 (Sol audit round 3): the gate used to compare ONLY the override
  // slice — so rejecting a match (or accepting a re-matched candidate,
  // BLOCK 2) after a duplicate_chunk_content collision changed the v2/v3
  // content_sha256 namespace server-side (confirmImportBatch's own
  // digest-construction comment) while this gate kept Confirm/Retry
  // hidden, since neither change was ever compared against anything. Now
  // compares all THREE slices this chunk's content_sha256 actually folds
  // in — a chunk only stays "unresolved" (Retry hidden) while EVERY ONE of
  // them still exactly matches what was sent with the failed attempt.
  const unresolvedDuplicateChunkContentIndexes = new Set(
    (chunkUpload ?? [])
      .filter((c) => c.status === "failed" && c.code === "duplicate_chunk_content")
      .filter((c) => {
        const bounds = chunkBreakdown?.find((cb) => cb.index === c.index);
        const currentOverridesSlice: RowOverrides = {};
        const currentRejectedSlice: number[] = [];
        const currentApprovedSlice: ApprovedLwinRows = {};
        if (bounds) {
          for (const [key, fields] of Object.entries(rowOverrides)) {
            const rowNumber = Number(key);
            if (rowNumber < bounds.startRow || rowNumber > bounds.endRow) continue;
            if (fields && Object.keys(fields).length > 0) currentOverridesSlice[rowNumber] = fields;
          }
          for (const rowNumber of effectiveRejectedLwinRows) {
            if (rowNumber >= bounds.startRow && rowNumber <= bounds.endRow) currentRejectedSlice.push(rowNumber);
          }
          for (const row of effectiveMatchedRows) {
            if (row.rowNumber < bounds.startRow || row.rowNumber > bounds.endRow) continue;
            // BLOCK 2 (round-13 fix): same fail-closed condition as
            // buildApprovedLwinRows — this slice must match what was
            // actually SENT with the failed attempt (sentApprovedLwinRowsSnapshot),
            // and buildApprovedLwinRows never sends an entry for a row with
            // no display identity.
            if (row.lwinScore >= LWIN_APPLY_MIN_SCORE && row.lwinDisplayName !== null) {
              currentApprovedSlice[row.rowNumber] = row.lwinId;
            }
          }
        }
        return (
          overridesSliceEqual(currentOverridesSlice, c.sentOverridesSnapshot ?? {}) &&
          numberSliceEqual(currentRejectedSlice, c.sentRejectedLwinRowsSnapshot ?? []) &&
          approvedSliceEqual(currentApprovedSlice, c.sentApprovedLwinRowsSnapshot ?? {})
        );
      })
      .map((c) => c.index),
  );
  const hasUnresolvedDuplicateChunkContent = unresolvedDuplicateChunkContentIndexes.size > 0;
  const blocksConfirmButton = hasChunkContentMismatch || hasUnresolvedDuplicateChunkContent;

  return (
    <div className="rounded-card card-surface p-lg">
      <h2 className="font-serif text-[20px] text-ink">Preview: {filename}</h2>
      {chunkTotal !== undefined ? (
        <p className="mt-2xs text-[13px] text-grey">
          This file will be split into {chunkTotal} chunk{chunkTotal === 1 ? "" : "s"} of up to{" "}
          {CLIENT_CHUNK_TARGET_ROWS} rows, uploaded one at a time under a single import session.{" "}
          {/* BLOCK 1 (round-11 fix, was WARN 4 round-29 audit): each chunk
              passing its own per-chunk time budget says nothing about the
              total wait for a multi-chunk file — stated honestly here,
              before the operator clicks Confirm and starts the (also
              sequential, also per-chunk-bounded) confirm phase. */}
          Confirming it is estimated to take up to{" "}
          {describeWaitEstimate(estimateChunkedPhaseWaitSeconds(chunkTotal))}, the same as preview.
        </p>
      ) : (
        // BLOCK 1 (round-11 fix): the plain (<= MAX_ROWS) path used to show
        // no wait estimate at all before Confirm — it previews/confirms as
        // a single unit, bounded by the exact same per-unit budget a
        // chunked file's own first chunk is, so the same estimate applies
        // here, stated before the operator clicks Confirm.
        <p className="mt-2xs text-[13px] text-grey">
          Confirming it is estimated to take up to {describeWaitEstimate(estimateChunkedPhaseWaitSeconds(1))}.
        </p>
      )}

      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <SummaryStat label="Total rows" value={summary.totalRows} />
        <SummaryStat label="Passing validation" value={effectivePassingValidationRows} />
        <SummaryStat label="Needs resolution" value={summary.pendingResolutionRows} />
        <SummaryStat label="Errors (excluded)" value={effectiveErrorRows} />
        <SummaryStat label="LWIN matched" value={summary.matchedRows} />
        <SummaryStat label="Missing cost" value={summary.missingCostRows} />
      </dl>
      <p className="mt-2xs text-caption text-grey">
        The server decides the final ready/needs-resolution split at import — missing costs and
        unmatched wines may still need resolution, and duplicate rows may merge.
      </p>
      {fixedCount > 0 && (
        <p className="mt-2xs text-caption text-grey">
          Includes {fixedCount} row{fixedCount === 1 ? "" : "s"} fixed above — re-checked when you confirm.
        </p>
      )}

      {chunkBreakdown && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">Chunk breakdown</h3>
          <ul className="mt-xs space-y-2xs">
            {chunkBreakdown.map((chunk) => (
              <li key={chunk.index} className="rounded-md bg-bridge-surface px-sm py-xs text-[13px] text-ink">
                Chunk {chunk.index} (rows {chunk.startRow}–{chunk.endRow}): {chunk.summary.validRows} valid,{" "}
                {chunk.summary.errorRows} error(s)
              </li>
            ))}
          </ul>
        </div>
      )}

      {shownErrorRows.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Row errors
          </h3>
          <p className="mt-2xs text-caption text-grey">
            Edit a field below to fix a row inline — it counts toward the import once it&rsquo;s valid.
          </p>
          {confirming && (
            // Sol round-3 audit (2026-08-27) finding 1: a confirm attempt
            // snapshots rowOverrides the instant it starts — any edit made
            // while it's in flight can never actually be sent for chunks
            // this attempt already dispatched (or is about to), so every
            // input freezes for the duration rather than accepting an edit
            // that would silently go nowhere. isRowLocked (below) governs
            // the PERMANENT lock once a chunk is actually confirmed; this
            // is the separate, temporary freeze for the attempt itself.
            <p role="status" className="mt-2xs flex items-center gap-xs text-caption text-accent">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Import in progress — row edits are locked during upload.
            </p>
          )}
          <ul className="mt-xs space-y-2xs">
            {shownErrorRows.map((row) => (
              <RowFixItem
                key={row.rowNumber}
                row={row}
                override={rowOverrides[row.rowNumber]}
                onFieldChange={onRowFieldChange}
                locked={isRowLocked(row.rowNumber)}
                skipped={isRowSkipped?.(row.rowNumber) ?? false}
                frozen={confirming}
              />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <>
              <p role="alert" className="mt-2xs flex items-start gap-xs text-caption text-accent">
                <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {hiddenCount} more row(s) with errors are not shown yet.
              </p>
              <button
                type="button"
                onClick={() => setShownCount((count) => count + MAX_SHOWN_ERROR_ROWS)}
                className="mt-xs min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
              >
                Show {Math.min(hiddenCount, MAX_SHOWN_ERROR_ROWS)} more row(s) with errors
              </button>
            </>
          )}
        </div>
      )}

      {shownMatchedRows.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Matched wines ({linkingMatchedRows.length})
          </h3>
          <p className="mt-2xs text-caption text-grey">
            Each row below matched a wine in the catalog and will link it on import — reject a match you
            don&rsquo;t trust and it imports with no catalog link, exactly like a row that never matched.
          </p>
          <ul className="mt-xs space-y-2xs">
            {shownMatchedRows.map((row) => (
              <MatchedLwinRowItem
                key={row.rowNumber}
                row={row}
                rejected={effectiveRejectedLwinRows.has(row.rowNumber)}
                onToggle={onToggleLwinReject ?? (() => {})}
                // Same PERMANENT lock as RowFixItem's own `locked` — a row
                // whose chunk is already confirmed can never be resent, so
                // a reject click here would silently go nowhere (Sol
                // round-2 audit finding 1's exact reasoning, applied to
                // this new control).
                locked={isRowLocked(row.rowNumber)}
                skipped={isRowSkipped?.(row.rowNumber) ?? false}
                frozen={confirming}
              />
            ))}
          </ul>
          {hiddenMatchedCount > 0 && (
            <button
              type="button"
              onClick={() => setShownMatchedCount((count) => count + MAX_SHOWN_MATCHED_ROWS)}
              className="mt-xs min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            >
              Show {Math.min(hiddenMatchedCount, MAX_SHOWN_MATCHED_ROWS)} more matched row(s)
            </button>
          )}
        </div>
      )}

      {/* BLOCK 3 (Sol audit round 3, finding 3): a candidate scoring below
          LWIN_APPLY_MIN_SCORE is never stamped by apply regardless of
          operator action (0108's own lwin_score >= LWIN_APPLY_MIN_SCORE
          gate) — shown honestly, in its own band, with NO reject control:
          rejecting something that was never going to be applied is
          meaningless (this brief's own wording). */}
      {shownBelowThresholdRows.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Below match threshold ({belowThresholdMatchedRows.length})
          </h3>
          <p className="mt-2xs text-caption text-grey">
            These scored below the {LWIN_APPLY_MIN_SCORE.toFixed(2)} confidence bar apply requires to link a
            catalog entry — they&rsquo;ll import with no wine-catalog link no matter what you do here.
          </p>
          <ul className="mt-xs space-y-2xs">
            {shownBelowThresholdRows.map((row) => (
              <BelowThresholdLwinRowItem key={row.rowNumber} row={row} />
            ))}
          </ul>
          {hiddenBelowThresholdCount > 0 && (
            <button
              type="button"
              onClick={() => setShownBelowThresholdCount((count) => count + MAX_SHOWN_MATCHED_ROWS)}
              className="mt-xs min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            >
              Show {Math.min(hiddenBelowThresholdCount, MAX_SHOWN_MATCHED_ROWS)} more row(s)
            </button>
          )}
        </div>
      )}

      {chunkUpload && (
        <ChunkUploadProgress
          chunks={chunkUpload}
          chunkTotal={chunkTotal ?? chunkUpload.length}
          onSkipChunk={onSkipChunk}
          onImportAnyway={onImportAnyway}
          onUndoSkip={onUndoSkip}
          // Round-7 audit finding 4: the same in-flight freeze RowFixItem's
          // own `frozen` prop already applies to row-edit inputs above —
          // Skip/Undo-skip/Import-anyway are chunk actions with the exact
          // same race (a click here would be silently overwritten by the
          // driver's next progress write), so they freeze together.
          frozen={confirming}
        />
      )}

      {/* Round-27 audit (removes the in-preview conflict-recovery panel,
          which failed five straight audits — see docs/runbooks/
          csv-import.md): this is now the ONLY guidance shown for a
          conflict, including multiple_live_batches and duplicate_race_retry
          — the server's own message, verbatim, with no separate standing
          instruction competing with it. Confirm/Retry stays available below
          (blocksConfirmButton no longer treats either code as terminal);
          recovery for multiple_live_batches is under Recent imports. */}
      {error && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-accent">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <div className="mt-lg flex flex-col-reverse gap-sm sm:flex-row">
        <button
          type="button"
          onClick={onBack}
          disabled={confirming}
          className="min-h-11 flex-1 rounded-pill border border-ink/25 bg-surface px-lg text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Choose a different file
        </button>
        {!blocksConfirmButton && (
          <button
            type="button"
            disabled={!canConfirm || confirming}
            onClick={onConfirm}
            className="flex min-h-11 flex-1 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {confirming ? "Creating import…" : hasFailedChunk ? "Retry upload" : "Confirm import"}
          </button>
        )}
      </div>
      {!blocksConfirmButton && !canConfirm && (
        <p className="mt-sm text-caption text-grey">No valid rows to import yet — fix a row below, or choose a different file.</p>
      )}
    </div>
  );
}

/** One error row's inline fix form: an input per field the row actually
 * failed on, prefilled with the exact text that failed (rawText), live
 * re-validated through the SAME row-validator.ts logic the server uses —
 * so "this row will now import" is never a guess.
 *
 * Sol round-2 audit (2026-08-27) finding 1: once `locked` (this row's
 * chunk is already confirmed), further edits could never actually be
 * resent — confirmChunkedSession's retry loop skips a confirmed chunk
 * entirely — so the inputs render read-only/disabled instead of silently
 * accepting edits that would go nowhere.
 *
 * Sol round-3 audit (2026-08-27) finding 1: `frozen` is the separate,
 * TEMPORARY freeze for a confirm attempt currently in flight — the
 * attempt snapshots rowOverrides the instant it starts, so an edit made
 * while it's running could never actually be sent, for the same reason
 * `locked` disables a row (it would silently go nowhere). Unlike `locked`,
 * `frozen` clears once the attempt settles — a row in a failed or
 * never-attempted chunk becomes editable again.
 *
 * finding 5: the LABEL is "Chunk N, data row M" when row carries
 * chunkIndex/chunkRowNumber (the chunked path) — an honest, chunk-scoped
 * claim — never "Row {row.rowNumber}" for that path, since rowNumber
 * there is a startRow-adjusted number that can look like, but is not, a
 * true physical spreadsheet row (see ErrorRowEntry's own comment). The
 * plain (non-chunked) path has no chunk concept, so it keeps "Row N". */
function RowFixItem({
  row,
  override,
  onFieldChange,
  locked,
  skipped,
  frozen,
}: {
  row: ErrorRowEntry;
  override: Partial<Record<CanonicalHeader, string>> | undefined;
  onFieldChange: (rowNumber: number, field: CanonicalHeader, value: string) => void;
  locked: boolean;
  /** Round-6 audit finding 5: true for a row belonging to a client-side
   * skipped chunk — its edits are exactly as impossible to ever resend as
   * a `locked` row's, but the reason (and the way back — "Undo skip") is
   * different, so it renders a distinct message. */
  skipped: boolean;
  frozen: boolean;
}) {
  const disabled = locked || skipped || frozen;
  const effective: Record<CanonicalHeader, string> = { ...row.rawText, ...override };
  const live = validateFields(effective);
  const editableFields = Array.from(new Set(row.errors.map((e) => e.field))).filter(
    (field): field is CanonicalHeader => (CANONICAL_HEADERS as readonly string[]).includes(field),
  );
  const label =
    row.chunkIndex !== undefined && row.chunkRowNumber !== undefined
      ? `Chunk ${row.chunkIndex}, data row ${row.chunkRowNumber}`
      : `Row ${row.rowNumber}`;

  return (
    <li className="rounded-md bg-bridge-surface px-sm py-xs text-[13px] text-ink">
      <div className="flex items-center gap-xs">
        <span>{label}</span>
        {!disabled && live.state === "valid" && (
          <span className="inline-flex items-center gap-2xs text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Fixed
          </span>
        )}
      </div>
      <p className="mt-2xs text-caption text-grey">
        {locked
          ? "Row already imported with this chunk — revert the import to change it."
          : skipped
            ? "Row belongs to a skipped chunk."
            : frozen
              ? "Import in progress — this row is locked until the upload finishes."
              : live.state === "error"
                ? live.errors.map((e) => e.message).join(" ")
                : "This row will be imported once you confirm."}
      </p>
      <div className="mt-xs flex flex-wrap gap-sm">
        {editableFields.map((field) => (
          <label key={field} className="flex flex-col gap-2xs text-caption text-grey">
            {FIELD_LABELS[field]}
            <input
              type="text"
              value={effective[field] ?? ""}
              onChange={(e) => onFieldChange(row.rowNumber, field, e.target.value)}
              maxLength={MAX_FIELD_LENGTH}
              disabled={disabled}
              readOnly={disabled}
              className={cn(
                "min-h-11 w-32 rounded-pill border border-hairline bg-surface px-sm text-[13px] text-ink focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
                disabled && "cursor-not-allowed opacity-60",
              )}
            />
          </label>
        ))}
      </div>
    </li>
  );
}

/** Item 2 (per-row LWIN match visibility) — one matched row: the catalog's
 * own display name and match score, with a reject toggle. Rejecting is a
 * simple client-side flag, round-tripped through the SAME reject/accept
 * pair on every render (never a one-way action) — an operator can change
 * their mind right up until confirm, exactly like an inline row-fix edit
 * can. The label mirrors RowFixItem's own "Chunk N, data row M" vs
 * "Row N" convention (see its own comment). */
function MatchedLwinRowItem({
  row,
  rejected,
  onToggle,
  locked,
  skipped,
  frozen,
}: {
  row: MatchedLwinRowEntry;
  rejected: boolean;
  onToggle: (rowNumber: number) => void;
  /** Sol round-2 audit finding 1's reasoning, applied to this new control:
   * a row whose chunk is already CONFIRMED can never be resent, so a
   * reject click here would silently go nowhere — disabled with the same
   * explanatory copy RowFixItem uses. Always false on the plain
   * (non-chunked) path. */
  locked: boolean;
  /** Round-6 audit finding 5's counterpart — a row belonging to a
   * client-side skipped chunk, same reasoning as `locked`. */
  skipped: boolean;
  /** Same TEMPORARY in-flight freeze RowFixItem's own `frozen` prop
   * applies — a reject/undo click while a confirm attempt is already
   * dispatching this row's rejection state would otherwise be silently
   * overwritten by that attempt's own snapshot. */
  frozen: boolean;
}) {
  const disabled = locked || skipped || frozen;
  const label = row.chunkIndex !== undefined && row.chunkRowNumber !== undefined
    ? `Chunk ${row.chunkIndex}, data row ${row.chunkRowNumber}`
    : `Row ${row.rowNumber}`;
  return (
    <li className="rounded-md bg-bridge-surface px-sm py-xs text-[13px] text-ink">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div>
          <span>{label}</span>
          <p className="mt-2xs text-caption text-grey">
            {locked
              ? "Row already imported with this chunk — revert the import to change it."
              : skipped
                ? "Row belongs to a skipped chunk."
                : rejected
                  ? "Match rejected — will import with no wine-catalog link, same as an unmatched row."
                  : `${row.lwinDisplayName ?? "Catalog entry (name unavailable)"} — match score ${row.lwinScore.toFixed(2)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(row.rowNumber)}
          disabled={disabled}
          className="min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {rejected ? "Undo reject" : "Reject match"}
        </button>
      </div>
    </li>
  );
}

/** BLOCK 3 (Sol audit round 3, finding 3) — one below-apply-threshold
 * candidate: the catalog's own display name and match score, exactly like
 * MatchedLwinRowItem's own display line, but deliberately with NO reject
 * control — apply's own lwin_score >= LWIN_APPLY_MIN_SCORE gate (0108)
 * already guarantees this row imports with no wine-catalog link, so a
 * reject toggle here would be a control that changes nothing. */
function BelowThresholdLwinRowItem({ row }: { row: MatchedLwinRowEntry }) {
  const label = row.chunkIndex !== undefined && row.chunkRowNumber !== undefined
    ? `Chunk ${row.chunkIndex}, data row ${row.chunkRowNumber}`
    : `Row ${row.rowNumber}`;
  return (
    <li className="rounded-md bg-bridge-surface px-sm py-xs text-[13px] text-ink">
      <span>{label}</span>
      <p className="mt-2xs text-caption text-grey">
        {row.lwinDisplayName ?? "Catalog entry (name unavailable)"} — match score {row.lwinScore.toFixed(2)}, will
        import with no catalog link.
      </p>
    </li>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-grey">{label}</dt>
      <dd className="tabular text-[20px] font-medium text-ink">{value}</dd>
    </div>
  );
}

/** BLOCK 2 (round-13 audit): the SAME confirmation copy BatchStep's own
 * "Revert this import" button uses, shared as a single source rather than
 * duplicated — the conflict-panel Revert button (PreviewStep) is exactly as
 * destructive as BatchStep's, since a conflict candidate can be 'applying'
 * or 'completed' too (revert_import_batch, 0109, accepts any status <>
 * 'reverted'). A one-off dialog/copy for the conflict panel was explicitly
 * what the finding asked NOT to build. */
const REVERT_CONFIRMATION = {
  title: "Revert this import?",
  description:
    "Removes the inventory this import created. Where it can safely confirm it, it also deletes wines only this import added and clears the wine-catalog (LWIN) links it wrote — including a link identical to one that existed before the import. Cleanup is best-effort: it deletes only wines it can confirm are unreferenced at that moment, and reports what it did below.",
  confirmLabel: "Revert import",
};

/** The revert route's response body (src/app/api/import/batches/[id]/revert/
 * route.ts) — consumed by BatchStep's success panel instead of being
 * discarded (Sol audit 2026-08-27 round 4, finding 3). */
type RevertResult = {
  revertedCount: number;
  orphanWinesDeleted: number;
  lwinStampsCleared: number;
  cleanupTruncated: boolean;
  orphanCleanupSkipped: boolean;
  /** Sol audit 2026-08-27 round 5, finding 3 — count of every caught
   * cleanup-phase error the revert swallowed (snapshot-read failure,
   * either cleanup step's own top-level catch, or a per-candidate
   * delete/update failure). Independent of `cleanupTruncated`
   * (deadline, not an error) and `orphanCleanupSkipped` (no service
   * client at all, not a request failing). */
  cleanupFailures: number;
};

/** Plain-language summary of a revert's actual outcome, including every
 * way catalog cleanup can come back incomplete (Sol audit 2026-08-27
 * round 4, finding 3 — the response used to be parsed and discarded
 * entirely; round 5, finding 3 — the notices below now COMPOSE instead of
 * an else-if silently dropping one when more than one applies, and
 * `cleanupFailures` gets its own notice). Never suggests reverting again:
 * the batch is already reverted, so — matching docs/runbooks/csv-import.md's
 * own recovery path — the follow-up for a partial cleanup is a manual
 * pass or re-running LWIN matching, not repeating this action. */
function summarizeRevertResult(result: RevertResult): string {
  const parts = [
    `Removed ${result.revertedCount} inventory row(s) this import created. Where it could safely confirm it, ` +
      `this also deleted ${result.orphanWinesDeleted} wine(s) this import added and cleared ` +
      `${result.lwinStampsCleared} wine-catalog (LWIN) link(s) it wrote — including any link identical to one ` +
      `that existed before the import (re-running LWIN matching restores it if needed).`,
  ];
  // Sol audit round 5, finding 3: these are independent conditions, not
  // mutually exclusive branches — an else-if here would silently drop
  // whichever notice came second when more than one flag is set.
  if (result.orphanCleanupSkipped) {
    parts.push("Orphan-wine cleanup was skipped — service configuration missing. See the CSV import runbook.");
  }
  if (result.cleanupTruncated) {
    parts.push("Catalog cleanup didn't finish in time and was left partial. See the CSV import runbook for the manual follow-up.");
  }
  if (result.cleanupFailures > 0) {
    parts.push("Some cleanup steps failed — see the CSV import runbook.");
  }
  return parts.join(" ");
}

/** Exported so import-client.test.tsx can pin the reverted-batch banner
 * directly (Sol round-5 audit finding 2's client-detectability ask). */
export function BatchStep({
  batch,
  setBatch,
  onDone,
}: {
  batch: BatchDetail;
  setBatch: (b: BatchDetail) => void;
  onDone: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);
  const [revertResult, setRevertResult] = useState<RevertResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualCostDrafts, setManualCostDrafts] = useState<Record<string, string>>({});

  const pending = batch.rows.filter((r) => r.resolution === "pending");
  const eligibleNotApplied = batch.rows.filter(
    (r) => r.apply_status === "not_applied" && (r.resolution === "auto" || r.resolution === "include"),
  );
  const appliedCount = batch.rows.filter((r) => r.apply_status === "applied").length;

  const refresh = useCallback(async () => {
    await loadBatchDetail(batch.batch.id, setBatch);
  }, [batch.batch.id, setBatch]);

  const applyAll = useCallback(async () => {
    setApplying(true);
    setActionError(null);
    try {
      let done = false;
      let guard = 0;
      while (!done && guard < 200) {
        guard += 1;
        const response = await fetch(`/api/import/batches/${batch.batch.id}/apply`, { method: "POST" });
        const body = await response.json();
        if (!response.ok) {
          setActionError(body?.error?.message ?? "Apply failed.");
          break;
        }
        // Round-8 audit finding 3: a batch reverted mid-apply (e.g. by a
        // concurrent reconciliation cleanup) already makes `done` true via
        // the apply route's own batchStatus check — checked again here
        // directly so this loop stops the instant it sees "reverted" even
        // if `done`'s own derivation ever changes. `refresh()` below then
        // pulls the batch's real status, surfacing the existing
        // reverted-batch banner.
        done = body.done || body.batchStatus === "reverted";
        await refresh();
      }
    } catch {
      setActionError("Apply failed. Your progress so far is saved — try again.");
    } finally {
      setApplying(false);
    }
  }, [batch.batch.id, refresh]);

  const resolveRow = useCallback(
    async (rowId: string, action: "include" | "exclude", manualUnitCost?: number) => {
      setActionError(null);
      try {
        const response = await fetch(`/api/import/batches/${batch.batch.id}/rows/${rowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, manualUnitCost }),
        });
        const body = await response.json();
        if (!response.ok) {
          setActionError(body?.error?.message ?? "Could not resolve row.");
          return;
        }
        await refresh();
      } catch {
        setActionError("Could not resolve row. Check your connection and try again.");
      }
    },
    [batch.batch.id, refresh],
  );

  const doRevert = useCallback(async () => {
    setReverting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/import/batches/${batch.batch.id}/revert`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body?.error?.message ?? "Revert failed.");
        return;
      }
      // Sol audit 2026-08-27 round 4, finding 3: the response is consumed,
      // not discarded — show a success panel with the actual counts
      // (revertedCount/orphanWinesDeleted/lwinStampsCleared) and any
      // partial-cleanup warning, instead of silently navigating away.
      setRevertResult(body as RevertResult);
      setRevertDialogOpen(false);
    } catch {
      setActionError("Revert failed. Check your connection and try again.");
    } finally {
      setReverting(false);
    }
  }, [batch.batch.id]);

  if (revertResult) {
    return (
      <div className="rounded-card card-surface p-lg">
        <div className="flex items-center gap-xs">
          <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="font-serif text-[20px] text-ink">Import reverted</h2>
        </div>
        <p className="mt-sm text-[14px] text-ink">{summarizeRevertResult(revertResult)}</p>
        <button
          type="button"
          onClick={onDone}
          className="mt-lg flex min-h-11 w-full items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-card card-surface p-lg">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-[20px] text-ink">{batch.batch.filename}</h2>
        <StatusBadge status={batch.batch.status} />
      </div>

      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <SummaryStat label="Total rows" value={batch.batch.total_rows} />
        <SummaryStat label="Applied" value={appliedCount} />
        <SummaryStat label="Needs resolution" value={pending.length} />
        <SummaryStat label="Ready, not yet applied" value={eligibleNotApplied.length} />
      </dl>

      {actionError && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-accent">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {pending.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Needs your decision ({pending.length})
          </h3>
          <ul className="mt-xs space-y-sm">
            {pending.map((row) => (
              <li key={row.id} className="rounded-lg card-surface p-sm">
                <p className="text-[14px] text-ink">
                  Row {row.row_number}: {row.raw.producer ? `${row.raw.producer} — ` : ""}{row.raw.name}
                </p>
                <p className="mt-2xs text-caption text-grey">
                  {row.lwin_status === "unmatched" ? "No LWIN catalog match. " : ""}
                  {row.cost_status === "missing" ? "No unit cost provided." : ""}
                </p>
                <div className="mt-sm flex flex-wrap items-center gap-sm">
                  {row.cost_status === "missing" && (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Unit cost"
                      value={manualCostDrafts[row.id] ?? ""}
                      onChange={(e) => setManualCostDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="min-h-11 w-28 rounded-pill border border-hairline bg-surface px-sm text-[14px] focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const draft = manualCostDrafts[row.id];
                      const manualUnitCost = row.cost_status === "missing" && draft ? Number(draft) : undefined;
                      void resolveRow(row.id, "include", manualUnitCost);
                    }}
                    disabled={row.cost_status === "missing" && !manualCostDrafts[row.id]}
                    className="min-h-11 rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Include anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveRow(row.id, "exclude")}
                    className="min-h-11 rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
                  >
                    Exclude
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Round-5 audit finding 2: a batch that self-reverted via the
          SEER-YIELDS race protocol before anything was ever applied still
          has rows sitting at apply_status='not_applied' — eligibleNotApplied
          stays nonzero even though the batch itself is dead. apply_import_batch_chunk_v2
          already no-ops on a reverted batch (batch-service.ts), so clicking
          Apply here would silently do nothing; batch.batch.status is a
          fresh server read (GET /api/import/batches/[id]) so this is
          cheaply, reliably detectable — the operator gets an honest
          explanation instead of a confusing no-op button. Data-safe either
          way: apply only ever selects apply_status='not_applied' rows, and
          this is refused for clarity, not because resuming would be unsafe.

          Round-6 audit finding 6: the earlier copy ("superseded by a
          duplicate import") ASSERTED a specific cause this component has
          no way to actually know — a batch reaches status='reverted' for
          any reason a revert can happen, including the operator's OWN
          deliberate revert (same "Revert this import" button, same
          resulting shape: reverted with rows still not_applied whenever
          the revert landed before Apply was ever clicked). Reworded to the
          neutral, always-true fact: it was reverted, its rows were never
          applied, re-upload to try again — no claim about why. */}
      {batch.batch.status === "reverted" && eligibleNotApplied.length > 0 && (
        <p role="status" className="mt-md text-[13px] text-grey">
          This import batch was reverted. Its rows were not imported; upload the file again to re-import.
        </p>
      )}

      <div className="mt-lg flex flex-col gap-sm">
        {eligibleNotApplied.length > 0 && batch.batch.status !== "reverted" && (
          <button
            type="button"
            disabled={applying}
            onClick={applyAll}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {applying ? `Applying… (${appliedCount} of ${batch.batch.total_rows})` : `Apply ${eligibleNotApplied.length} row(s)`}
          </button>
        )}

        {/* Round-10 audit (BLOCK 3(b)): the revert RPC (revert_import_batch,
            0109) accepts any status <> 'reverted' — 'created', 'applying',
            AND 'completed' — specifically so a batch that's merely confirmed
            or partially applied can be reverted too (0109's own comment).
            This button used to only appear once status === "completed",
            which meant a multiple_live_batches conflict naming a batch still
            sitting at 'created' or 'applying' pointed the operator at a
            Revert control that didn't exist yet — a dead end. Matched to
            what the endpoint actually accepts. */}
        {batch.batch.status !== "reverted" && (
          <button
            type="button"
            onClick={() => setRevertDialogOpen(true)}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill border border-ink/25 bg-surface px-lg text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Revert this import
          </button>
        )}

        <button
          type="button"
          onClick={onDone}
          className="min-h-11 rounded-pill px-lg text-[14px] font-medium text-ink-muted underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        >
          Start a new import
        </button>
      </div>

      <ActionDialog
        open={revertDialogOpen}
        title={REVERT_CONFIRMATION.title}
        description={REVERT_CONFIRMATION.description}
        confirmLabel={REVERT_CONFIRMATION.confirmLabel}
        busy={reverting}
        onConfirm={() => void doRevert()}
        onClose={() => setRevertDialogOpen(false)}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: BatchSummary["status"] }) {
  const label = {
    created: "Not yet applied",
    applying: "In progress",
    completed: "Completed",
    reverted: "Reverted",
  }[status];
  return (
    <span className="inline-flex items-center gap-2xs rounded-pill bg-bridge-surface px-sm py-2xs text-caption font-medium text-ink">
      {status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </span>
  );
}

function RecentImports({
  batches,
  onOpen,
}: {
  batches: BatchSummary[] | null;
  onOpen: (id: string) => void;
}) {
  if (!batches || batches.length === 0) return null;
  return (
    <section className="mt-lg">
      <h2 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">Recent imports</h2>
      {/* Round-27 audit: this used to show only the ten newest, which made
          the in-preview conflict panel the only way to reach an aged-out
          conflicting batch (that panel is now removed — see docs/runbooks/
          csv-import.md). GET /api/import/batches already returns every
          batch for this restaurant, newest first, with no server-side cap
          — showing all of them (rather than adding a new search UI) is the
          smallest change that keeps every non-reverted batch reachable and
          revertable from here. */}
      <ul className="mt-xs space-y-2xs">
        {batches.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onOpen(b.id)}
              className={cn(
                "flex min-h-11 w-full items-center justify-between rounded-lg card-surface px-sm text-left text-[13px] text-ink transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25",
              )}
            >
              <span className="truncate">{b.filename}</span>
              <span className="shrink-0 text-caption text-grey">{b.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
