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
import { CANONICAL_HEADERS, CLIENT_CHUNK_TARGET_ROWS, MAX_FIELD_LENGTH, MAX_ROWS, type CanonicalHeader } from "@/domains/import/constants";
import { validateFields } from "@/domains/import/row-validator";
import {
  AmbiguousRecordSplitError,
  UnsupportedEncodingError,
  UnsupportedLineEndingError,
  decodeCsvBytesStrict,
  splitLogicalRecords,
} from "@/domains/import/csv-splitter";
import type { PreviewRow, PreviewSummary } from "@/domains/import/preview-service";
import {
  SessionStep,
  ChunkUploadProgress,
  planChunkedPreview,
  confirmChunkedSessionWithResume,
  readStoredSession,
  writeStoredSession,
  ZERO_SUMMARY,
  type ChunkedPlanState,
  type ChunkedPreviewState,
  type ChunkUploadState,
} from "./session-step";

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
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; summary: PreviewSummary } | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Inline row-fix: rowNumber is GLOBAL (the number shown in the preview
  // UI) for both the plain and chunked paths — handleConfirmChunked
  // translates it back to each chunk's own local row numbers.
  const [rowOverrides, setRowOverrides] = useState<RowOverrides>({});
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
      const response = await fetch("/api/import/batches", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        setPreviewError(body?.error?.message ?? "Import could not be created.");
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
  }, [file, rowOverrides, loadRecent]);

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
  }, [chunkedPlan, chunkUpload, sessionId, file, sessionLabel, rowOverrides, loadRecent]);

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

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setPreviewError(null);
    setBatch(null);
    setChunkedPlan(null);
    setChunkedPreview(null);
    setChunkUpload(null);
    setSessionId(null);
    setSessionLabel("cellar.csv");
    setRowOverrides({});
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  return (
    <div className="mx-auto max-w-[640px] px-md py-lg">
      <header className="mb-lg">
        <h1 className="font-serif text-[28px] font-normal leading-tight text-ink">Import cellar</h1>
        <p className="mt-2xs text-[14px] text-grey">
          Upload a CSV of your existing inventory. Nothing is written to your cellar until you confirm the preview.
        </p>
      </header>

      {step === "upload" && (
        <UploadStep
          file={file}
          setFile={setFile}
          fileInputRef={fileInputRef}
          onPreview={handlePreview}
          previewing={previewing}
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

function UploadStep({
  file,
  setFile,
  fileInputRef,
  onPreview,
  previewing,
  error,
}: {
  file: File | null;
  setFile: (f: File | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPreview: () => void;
  previewing: boolean;
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
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white">
          <Upload className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="text-[14px] font-medium text-ink">
          {file ? file.name : "Choose a CSV file"}
        </span>
        <span className="text-caption text-grey">
          .csv up to 5 MB per upload — larger files split into {CLIENT_CHUNK_TARGET_ROWS}-row chunks automatically
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-accent">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!file || previewing}
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
  // Round-10 audit (BLOCK 3(a)): multiple_live_batches (reconciliation's
  // own non-destructive conflict — see reconcileLiveBatchesForFile's own
  // comment) and duplicate_race_retry_exhausted (WARN 5's bounded
  // escalation, session-step.tsx) are the SAME kind of dead end as
  // chunk_content_mismatch — retrying re-sends the exact same request and
  // fails the exact same way every time, with no fix reachable from inside
  // this UI. Genuinely terminal: never offer "Retry upload" for either.
  const hasTerminalReconciliationConflict =
    chunkUpload?.some(
      (c) => c.status === "failed" && (c.code === "multiple_live_batches" || c.code === "duplicate_race_retry_exhausted"),
    ) ?? false;
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
  const unresolvedDuplicateChunkContentIndexes = new Set(
    (chunkUpload ?? [])
      .filter((c) => c.status === "failed" && c.code === "duplicate_chunk_content")
      .filter((c) => {
        const bounds = chunkBreakdown?.find((cb) => cb.index === c.index);
        const currentSlice: RowOverrides = {};
        if (bounds) {
          for (const [key, fields] of Object.entries(rowOverrides)) {
            const rowNumber = Number(key);
            if (rowNumber < bounds.startRow || rowNumber > bounds.endRow) continue;
            if (fields && Object.keys(fields).length > 0) currentSlice[rowNumber] = fields;
          }
        }
        return overridesSliceEqual(currentSlice, c.sentOverridesSnapshot ?? {});
      })
      .map((c) => c.index),
  );
  const hasUnresolvedDuplicateChunkContent = unresolvedDuplicateChunkContentIndexes.size > 0;
  const blocksConfirmButton = hasChunkContentMismatch || hasUnresolvedDuplicateChunkContent || hasTerminalReconciliationConflict;

  return (
    <div className="rounded-card card-surface p-lg">
      <h2 className="font-serif text-[20px] text-ink">Preview: {filename}</h2>
      {chunkTotal !== undefined && (
        <p className="mt-2xs text-[13px] text-grey">
          This file will be split into {chunkTotal} chunk{chunkTotal === 1 ? "" : "s"} of up to{" "}
          {CLIENT_CHUNK_TARGET_ROWS} rows, uploaded one at a time under a single import session.
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

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-grey">{label}</dt>
      <dd className="tabular text-[20px] font-medium text-ink">{value}</dd>
    </div>
  );
}

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
        title="Revert this import?"
        description="Removes the inventory this import created. Where it can safely confirm it, it also deletes wines only this import added and clears the wine-catalog (LWIN) links it wrote — including a link identical to one that existed before the import. Cleanup is best-effort: it deletes only wines it can confirm are unreferenced at that moment, and reports what it did below."
        confirmLabel="Revert import"
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
      <ul className="mt-xs space-y-2xs">
        {batches.slice(0, 10).map((b) => (
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
