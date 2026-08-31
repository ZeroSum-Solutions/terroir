"use client";

// The import screen's state machine: it owns file selection, the
// upload/preview/batch/session step, every operator decision (inline row
// fixes, LWIN rejections, chunk skips) and the resume-on-mount check, and
// hands each step's rendering to its own sibling module.
//
// Everything that was pure, non-React logic here — the preview-unit count,
// the LWIN approval payload, the chunk-upload predicates and transitions,
// the "Import anyway" override scheme, the duplicate-chunk retry gate, the
// preview counts, the wait-estimate wording and the revert summary — now
// lives under src/domains/import/, where it is directly unit-testable
// without rendering a React tree. Every name that moved is re-exported
// below, unchanged, so no caller or test needs to know.

import { useCallback, useEffect, useRef, useState } from "react";
import { type CanonicalHeader } from "@/domains/import/constants";
import type { PreviewRow, PreviewSummary } from "@/domains/import/preview-service";
import type { SourcePresetId } from "@/domains/import/source-presets";
import type { BatchDetail, BatchSummary } from "@/domains/import/batch-api-types";
import type { RejectedLwinRows, RowOverrides } from "@/domains/import/review-types";
import { preparePreviewRun } from "@/domains/import/preview-dispatch";
import { confirmSingleFileImport, requestSingleFilePreview } from "@/domains/import/single-file-import";
import { buildApprovedLwinRows, matchedRowsFromPreviewRows } from "@/domains/import/lwin-approval";
import {
  isRowInConfirmedChunk,
  isRowInSkippedChunk,
  skipChunk,
  undoSkipChunk,
} from "@/domains/import/chunk-upload-actions";
import { buildImportAnywayOverride } from "@/domains/import/import-anyway";
import {
  SessionStep,
  confirmChunkedSessionWithResume,
  planChunkedPreview,
  writeStoredSession,
  ZERO_SUMMARY,
  type ChunkedPlanState,
  type ChunkedPreviewState,
  type ChunkUploadState,
} from "./session-step";
import { convertSpreadsheetFile, isSpreadsheetFile } from "./spreadsheet-upload";
import { takeHandoffFile } from "./spreadsheet-handoff";
import { useFileIntake } from "@/lib/upload/use-file-intake";
import { loadBatchDetail } from "./load-batch-detail";
import { UploadStep } from "./upload-step";
import { PreviewStep } from "./preview-step";
import { BatchStep } from "./batch-step";
import { RecentImports } from "./recent-imports";
import { usePreviewUnits } from "./use-preview-units";
import { useSessionResume } from "./use-session-resume";

// ---------------------------------------------------------------------------
// Re-exports. Kept here so every existing import of "./import-client"
// resolves exactly as it did before the split.
// ---------------------------------------------------------------------------
export type {
  ApprovedLwinRows,
  ErrorRowEntry,
  MatchedLwinRowEntry,
  RejectedLwinRows,
  RowOverrides,
} from "@/domains/import/review-types";
export type { BatchDetail, BatchRow, BatchSummary } from "@/domains/import/batch-api-types";
export { buildApprovedLwinRows } from "@/domains/import/lwin-approval";
export {
  isRowInConfirmedChunk,
  isRowInSkippedChunk,
  skipChunk,
  undoSkipChunk,
} from "@/domains/import/chunk-upload-actions";
export { buildImportAnywayOverride } from "@/domains/import/import-anyway";
export type { ImportAnywayGridRow, ImportAnywayOutcome } from "@/domains/import/import-anyway";
export { MAX_SHOWN_ERROR_ROWS } from "./preview-error-rows";
export { MAX_SHOWN_MATCHED_ROWS } from "./preview-lwin-rows";
export { PreviewStep } from "./preview-step";
export { BatchStep } from "./batch-step";

type Step = "upload" | "preview" | "batch" | "session";

export function ImportClient() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [conversionNotice, setConversionNotice] = useState<string | null>(null);
  // Set when a drop carried more than one file. An import takes one file, and
  // silently keeping the first of four is exactly the sort of partial import
  // nobody notices until the counts come out wrong.
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    rows: PreviewRow[];
    summary: PreviewSummary;
    detectedSource?: SourcePresetId | null;
  } | null>(null);
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
  const { previewUnits, previewUnitsStatus } = usePreviewUnits(file);
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

  useSessionResume((resumedSessionId, label) => {
    setSessionId(resumedSessionId);
    setSessionLabel(label);
    setStep("session");
  });

  const runSingleFilePreview = useCallback(async (selectedFile: File) => {
    const result = await requestSingleFilePreview(selectedFile);
    if (!result.ok) {
      setPreviewError(result.error);
      setPreview(null);
      return;
    }
    setPreview(result.preview);
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
      const plan = await preparePreviewRun(file);
      if (!plan.ok) {
        setPreviewError(plan.error);
        return;
      }
      if (plan.kind === "single") {
        await runSingleFilePreview(file);
      } else {
        await runChunkedPreview(file, plan.headerRecord, plan.dataRecords, plan.bytes);
      }
    } catch {
      setPreviewError("Preview failed. Check your connection and try again.");
    } finally {
      setPreviewing(false);
    }
  }, [file, runSingleFilePreview, runChunkedPreview]);

  // SD-41: acknowledgedMissingProducerRows is PreviewStep's own effective
  // count (inline fixes in, skipped chunks out) at the moment the operator
  // ticked the box and pressed Confirm — echoed back for the server to
  // re-check against its own re-derived rows. See producer-acknowledgement.ts.
  const handleConfirm = useCallback(async (acknowledgedMissingProducerRows: number) => {
    if (!file) return;
    setConfirming(true);
    try {
      const result = await confirmSingleFileImport({
        file,
        rowOverrides,
        rejectedLwinRows,
        previewRows: preview?.rows ?? null,
        acknowledgedMissingProducerRows,
      });
      if (!result.ok) {
        setPreviewError(result.error);
        return;
      }
      await loadBatchDetail(result.batchId, setBatch);
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
  const handleConfirmChunked = useCallback(async (acknowledgedMissingProducerRows: number) => {
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
        // SD-41: the WHOLE file's acknowledged count, sent with every
        // chunk. Each chunk's own server-side count can only be a subset of
        // it, so the >= comparison the guard makes holds for all of them.
        acknowledgedMissingProducerRows,
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

  // Dragging a file in from the desktop, or pasting one, reaches exactly the
  // same handler as choosing it from the dialog — conversion, validation,
  // chunking and preview all behave identically. Only accepted on the upload
  // step: a drop landing mid-preview would discard a reviewed import.
  const { isDragging } = useFileIntake({
    enabled: step === "upload" && !converting && !previewing,
    onFiles: (files) => {
      setDropNotice(
        files.length > 1
          ? `Took “${files[0].name}”. Import one file at a time — the other ${files.length - 1} were not read.`
          : null,
      );
      void handleFileSelected(files[0] ?? null);
    },
  });

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
    setDropNotice(null);
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
      {/* The whole window is the drop target — there is one upload here, so
          making the operator hit a rectangle buys nothing. */}
      {isDragging && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim p-lg"
        >
          <div className="rounded-card border-2 border-dashed border-surface-sunken bg-surface px-xl py-lg text-center">
            <p className="font-serif text-[20px] text-ink">Drop your cellar file</p>
            <p className="mt-xs text-[13px] text-grey">.csv or .xlsx — one file at a time</p>
          </div>
        </div>
      )}

      <header className="mb-lg">
        <h1 className="font-serif text-heading-sm md:text-heading font-normal leading-tight text-ink">Import cellar</h1>
        <p className="mt-2xs text-[14px] text-grey">
          Upload a CSV or Excel (.xlsx) file of your existing inventory — choose it, drag it in, or paste it. Nothing is written to your cellar until you confirm the preview.
        </p>
      </header>

      {step === "upload" && (
        <UploadStep
          file={file}
          setFile={(selected) => {
            setDropNotice(null);
            void handleFileSelected(selected);
          }}
          converting={converting}
          conversionNotice={conversionNotice}
          dropNotice={dropNotice}
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
          detectedSource={preview?.detectedSource ?? null}
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
          onConfirm={(ack) => void (chunkedPreview ? handleConfirmChunked(ack) : handleConfirm(ack))}
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
