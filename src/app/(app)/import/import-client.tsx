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
  confirmChunkedSession,
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

type BatchSummary = {
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

type BatchDetail = { batch: BatchSummary; rows: BatchRow[] };

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
   * retry-after-failure path reruns confirmChunkedSession with the prior
   * chunkUpload state as initialUpload, so only the failed/unsent chunks
   * are actually re-sent. See session-step.tsx for the sequential driver
   * itself. */
  const handleConfirmChunked = useCallback(async () => {
    if (!chunkedPlan) return;
    setConfirmingChunked(true);
    setPreviewError(null);
    try {
      const initial: ChunkUploadState[] =
        chunkUpload ??
        chunkedPlan.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null }));

      const result = await confirmChunkedSession({
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
        if (result.conflictingSessionId) {
          // This chunk's content already belongs to a DIFFERENT session —
          // never adopt it into this one (that would split the file across
          // two sessions). Resume the original session instead, but only
          // after verifying it really is THIS file's own unfinished
          // session: same source hash, still in progress. Anything else
          // (different file sharing one identical chunk, already-completed
          // or reverted session, unreachable progress) is a hard stop the
          // operator must resolve, not a silent redirect.
          try {
            const check = await fetch(`/api/import/sessions/${result.conflictingSessionId}`, { cache: "no-store" });
            const progress = check.ok
              ? ((await check.json()) as { status?: string; sourceSha256?: string | null })
              : null;
            if (
              progress?.status === "in_progress" &&
              progress.sourceSha256 != null &&
              progress.sourceSha256 === chunkedPlan.sourceSha256
            ) {
              const label = file?.name ?? sessionLabel;
              writeStoredSession({ sessionId: result.conflictingSessionId, sourceSha256: chunkedPlan.sourceSha256, label });
              setSessionId(result.conflictingSessionId);
              setSessionLabel(label);
              setPreviewError(result.error);
              setStep("session");
              return;
            }
          } catch {
            // fall through to the hard stop below
          }
          setPreviewError(
            "A chunk of this file matches content from another import that can't be resumed for this file " +
              "(different source file, or already completed/reverted). Revert that import before re-uploading.",
          );
          return;
        }
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
          chunkBreakdown={chunkedPreview?.perChunk}
          chunkTotal={chunkedPlan?.chunkTotal}
          chunkUpload={chunkUpload}
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
  chunkBreakdown,
  chunkTotal,
  chunkUpload,
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
  chunkBreakdown?: { index: number; startRow: number; endRow: number; summary: PreviewSummary }[];
  chunkTotal?: number;
  chunkUpload: ChunkUploadState[] | null;
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
  const fixedCount = shownErrorRows.filter(
    (row) => validateFields({ ...row.rawText, ...rowOverrides[row.rowNumber] }).state === "valid",
  ).length;
  const canConfirm = summary.validRows > 0 || fixedCount > 0;
  const hasFailedChunk = chunkUpload?.some((c) => c.status === "failed") ?? false;
  // Sol round-2 audit finding 3: chunk_content_mismatch is TERMINAL —
  // retrying re-sends this exact chunk's content and fails the same way
  // every time. Never offer "Retry upload" for it; the server's own
  // message (surfaced via `error` above) already explains the revert path.
  const hasChunkContentMismatch = chunkUpload?.some((c) => c.status === "failed" && c.code === "chunk_content_mismatch") ?? false;

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
        <SummaryStat label="Ready to apply" value={summary.readyToApplyRows} />
        <SummaryStat label="Needs resolution" value={summary.pendingResolutionRows} />
        <SummaryStat label="Errors (excluded)" value={summary.errorRows} />
        <SummaryStat label="LWIN matched" value={summary.matchedRows} />
        <SummaryStat label="Missing cost" value={summary.missingCostRows} />
      </dl>

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
          <ul className="mt-xs space-y-2xs">
            {shownErrorRows.map((row) => (
              <RowFixItem
                key={row.rowNumber}
                row={row}
                override={rowOverrides[row.rowNumber]}
                onFieldChange={onRowFieldChange}
                locked={isRowLocked(row.rowNumber)}
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

      {chunkUpload && <ChunkUploadProgress chunks={chunkUpload} chunkTotal={chunkTotal ?? chunkUpload.length} />}

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
        {!hasChunkContentMismatch && (
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
      {!hasChunkContentMismatch && !canConfirm && (
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
}: {
  row: ErrorRowEntry;
  override: Partial<Record<CanonicalHeader, string>> | undefined;
  onFieldChange: (rowNumber: number, field: CanonicalHeader, value: string) => void;
  locked: boolean;
}) {
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
        {!locked && live.state === "valid" && (
          <span className="inline-flex items-center gap-2xs text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Fixed
          </span>
        )}
      </div>
      <p className="mt-2xs text-caption text-grey">
        {locked
          ? "Row already imported with this chunk — revert the import to change it."
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
              disabled={locked}
              readOnly={locked}
              className={cn(
                "min-h-11 w-32 rounded-pill border border-hairline bg-surface px-sm text-[13px] text-ink focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
                locked && "cursor-not-allowed opacity-60",
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

function BatchStep({
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
        done = body.done;
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

      <div className="mt-lg flex flex-col gap-sm">
        {eligibleNotApplied.length > 0 && (
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

        {batch.batch.status === "completed" && (
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
