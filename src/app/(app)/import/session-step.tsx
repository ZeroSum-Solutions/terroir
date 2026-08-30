"use client";

// P3 — multi-batch onboarding session UI: per-chunk status, aggregate
// progress (GET /api/import/sessions/[id]), "Apply all" (drives each
// chunk's own /apply loop in turn), pending-row resolution sourced across
// every chunk, and revert-as-a-unit. Co-located with import-client.tsx,
// which owns all upload/session-creation state — this file only ever reads
// an existing sessionId and drives the session's own lifecycle from there.
//
// The chunked-upload "engine" this file used to also carry (chunk plan and
// upload-state types, localStorage resume, the wait estimate, and the
// preview/confirm drivers) now lives under src/domains/import/, where it is
// directly unit-testable without rendering a React tree. Every name that
// moved is re-exported below, unchanged, so no caller or test needs to know.
//
// Deliberately duplicates import-client.tsx's tiny SummaryStat markup
// (identical classes — see DESIGN.md's "one StatusChip pattern" contract)
// rather than importing it.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import type { BatchRow } from "@/domains/import/batch-api-types";
import type { SessionProgress } from "./session-progress-types";
import { SessionChunkList, type SkippedChunkSummary } from "./session-chunk-list";
import { SessionPendingRows } from "./session-pending-rows";

// ---------------------------------------------------------------------------
// Re-exports of the chunked-upload engine, now under src/domains/import/.
// Kept here so every existing import of "./session-step" resolves exactly as
// it did before the split.
// ---------------------------------------------------------------------------
export { ZERO_SUMMARY } from "@/domains/import/chunked-upload-types";
export type {
  ChunkPlanItem,
  ChunkPreviewEntry,
  ChunkUploadState,
  ChunkUploadStatus,
  ChunkedPlanState,
  ChunkedPreviewState,
} from "@/domains/import/chunked-upload-types";
export { readStoredSession, writeStoredSession } from "@/domains/import/session-storage";
export type { StoredSession } from "@/domains/import/session-storage";
export { estimateChunkedPhaseWaitSeconds } from "@/domains/import/wait-estimate";
export { planChunkedPreview } from "@/domains/import/chunked-preview";
export type { ChunkedPreviewResult } from "@/domains/import/chunked-preview";
export {
  localizeApprovedLwinRows,
  localizeRejectedLwinRows,
  localizeRowOverrides,
} from "@/domains/import/chunk-localization";
export { confirmChunkedSession } from "@/domains/import/chunked-confirm";
export type {
  ConfirmChunkedSessionParams,
  ConfirmChunkedSessionResult,
} from "@/domains/import/chunked-confirm";
export { confirmChunkedSessionWithResume } from "@/domains/import/chunked-confirm-resume";
export type { ConfirmChunkedSessionWithResumeResult } from "@/domains/import/chunked-confirm-resume";
export { ChunkUploadProgress } from "./chunk-upload-progress";
export type { SkippedChunkSummary } from "./session-chunk-list";

export function SessionStep({
  sessionId,
  label,
  skippedChunks,
  onDone,
}: {
  sessionId: string;
  label: string;
  /** See SkippedChunkSummary. Omitted (or empty) renders nothing extra. */
  skippedChunks?: SkippedChunkSummary[];
  onDone: () => void;
}) {
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingRows, setPendingRows] = useState<Record<string, BatchRow[]>>({});
  const [applying, setApplying] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualCostDrafts, setManualCostDrafts] = useState<Record<string, string>>({});

  // Never throws — a network/JSON failure here is common (this also runs
  // inside applyAllChunks' outer `finally`, where a throw would strand
  // `applying` permanently true) and instead surfaces as loadError with a
  // retry, distinct from the terminal "session not found" state.
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/import/sessions/${sessionId}`, { cache: "no-store" });
      if (!response.ok) {
        setNotFound(true);
        return;
      }
      setProgress(await response.json());
      setLoadError(null);
    } catch {
      setLoadError("Could not load this import session. Check your connection and try again.");
    }
  }, [sessionId]);

  useEffect(() => {
    // Deferred a tick so the initial fetch's state updates never run
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // Pending-row resolution, sourced across every chunk that has one —
  // tagged with its own chunkIndex so the operator knows which upload it
  // came from (P3 §3.3, this lane's brief §6).
  const pendingKey = progress
    ? progress.chunks
        .filter((c) => c.counts.pending > 0)
        .map((c) => `${c.batchId}:${c.counts.pending}`)
        .join(",")
    : "";

  useEffect(() => {
    if (!progress) return;
    let active = true;
    const idsWithPending = progress.chunks.filter((c) => c.counts.pending > 0).map((c) => c.batchId);
    if (idsWithPending.length === 0) {
      // Deferred a tick: no synchronous setState inside the effect body.
      void Promise.resolve().then(() => {
        if (active) setPendingRows({});
      });
      return () => {
        active = false;
      };
    }
    Promise.all(
      idsWithPending.map(async (batchId) => {
        const response = await fetch(`/api/import/batches/${batchId}`, { cache: "no-store" });
        if (!response.ok) return [batchId, []] as const;
        const detail = (await response.json()) as { rows: BatchRow[] };
        return [batchId, detail.rows.filter((r) => r.resolution === "pending")] as const;
      }),
    )
      .then((entries) => {
        if (active) setPendingRows(Object.fromEntries(entries));
      })
      .catch(() => {
        // best-effort — pending rows still show once a later refresh succeeds.
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const applyAllChunks = useCallback(async () => {
    if (!progress) return;
    setApplying(true);
    setActionError(null);
    try {
      for (const chunk of progress.chunks) {
        let done = chunk.counts.eligibleNotApplied === 0;
        let guard = 0;
        while (!done && guard < 200) {
          guard += 1;
          const response = await fetch(`/api/import/batches/${chunk.batchId}/apply`, { method: "POST" });
          const body = await response.json();
          if (!response.ok) {
            setActionError(body?.error?.message ?? `Apply failed on chunk ${chunk.chunkIndex ?? chunk.batchId}.`);
            return;
          }
          // Round-8 audit finding 3: see import-client.tsx's applyAll for
          // why this is checked directly rather than trusting `done`
          // alone — `refresh()` in the `finally` below then pulls this
          // chunk's real status, surfacing ChunkStatusChip's "Reverted".
          done = body.done || body.batchStatus === "reverted";
        }
      }
    } catch {
      setActionError("Apply failed. Your progress so far is saved — try again.");
    } finally {
      await refresh();
      setApplying(false);
    }
  }, [progress, refresh]);

  const resolveRow = useCallback(
    async (batchId: string, rowId: string, action: "include" | "exclude", manualUnitCost?: number) => {
      setActionError(null);
      try {
        const response = await fetch(`/api/import/batches/${batchId}/rows/${rowId}`, {
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
    [refresh],
  );

  // Bulk resolution across every chunk with pending rows — one
  // POST /resolve-all per chunk, sequential like every other loop here.
  // `include` only ever covers cost-present rows server-side; missing-cost
  // rows stay pending and keep their per-row manual-cost path below.
  const [bulkResolving, setBulkResolving] = useState(false);
  const bulkResolve = useCallback(
    async (action: "include" | "exclude") => {
      if (!progress) return;
      setBulkResolving(true);
      setActionError(null);
      try {
        for (const chunk of progress.chunks) {
          if (chunk.counts.pending === 0) continue;
          const response = await fetch(`/api/import/batches/${chunk.batchId}/resolve-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as
              | { error?: { message?: string } }
              | null;
            setActionError(body?.error?.message ?? "Could not bulk-resolve rows.");
            return;
          }
        }
        await refresh();
      } catch {
        setActionError("Could not bulk-resolve rows. Check your connection and try again.");
      } finally {
        setBulkResolving(false);
      }
    },
    [progress, refresh],
  );

  const doRevert = useCallback(async () => {
    setReverting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/import/sessions/${sessionId}/revert`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body?.error?.message ?? "Revert failed.");
        return;
      }
      setRevertDialogOpen(false);
      onDone();
    } catch {
      setActionError("Revert failed. Check your connection and try again.");
    } finally {
      setReverting(false);
    }
  }, [sessionId, onDone]);

  if (notFound) {
    return (
      <div className="rounded-card card-surface p-lg">
        <p className="text-[14px] text-ink">This import session could not be found.</p>
        <button
          type="button"
          onClick={onDone}
          className="mt-md min-h-11 rounded-pill px-lg text-[14px] font-medium text-grey underline underline-offset-4 hover:text-ink"
        >
          Start a new import
        </button>
      </div>
    );
  }

  if (!progress && loadError) {
    return (
      <div className="rounded-card card-surface p-lg">
        <p role="alert" className="flex items-start gap-xs text-[14px] text-risk-ink">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {loadError}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-md min-h-11 rounded-pill bg-primary px-lg text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!progress) {
    return (
      <div className="flex min-h-11 items-center justify-center gap-xs rounded-card card-surface p-lg text-[14px] text-grey">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading session…
      </div>
    );
  }

  const allPendingRows = Object.entries(pendingRows).flatMap(([batchId, rows]) => {
    const chunkIndex = progress.chunks.find((c) => c.batchId === batchId)?.chunkIndex ?? null;
    return rows.map((row) => ({ batchId, chunkIndex, row }));
  });

  return (
    <div className="rounded-card card-surface p-lg">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-[20px] text-ink">{label}</h2>
        <span className="inline-flex items-center gap-2xs rounded-pill bg-wash px-sm py-2xs text-caption font-medium text-ink">
          {progress.status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
          {progress.status === "in_progress" ? "In progress" : progress.status === "completed" ? "Completed" : "Reverted"}
        </span>
      </div>

      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <MiniStat label="Total rows" value={progress.totals.total} />
        <MiniStat label="Applied" value={progress.totals.applied} />
        <MiniStat label="Needs resolution" value={progress.totals.pending} />
        <MiniStat label="Ready, not yet applied" value={progress.totals.eligibleNotApplied} />
      </dl>

      <SessionChunkList progress={progress} skippedChunks={skippedChunks} />

      {actionError && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-risk-ink">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      <SessionPendingRows
        progress={progress}
        allPendingRows={allPendingRows}
        bulkResolving={bulkResolving}
        bulkResolve={bulkResolve}
        manualCostDrafts={manualCostDrafts}
        setManualCostDrafts={setManualCostDrafts}
        resolveRow={resolveRow}
      />

      <div className="mt-lg flex flex-col gap-sm">
        {progress.totals.eligibleNotApplied > 0 && (
          <button
            type="button"
            disabled={applying}
            onClick={() => void applyAllChunks()}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-seal-ink transition-colors hover:bg-primary-hover focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {applying
              ? `Applying… (${progress.totals.applied} of ${progress.totals.total})`
              : `Apply ${progress.totals.eligibleNotApplied} row(s)`}
          </button>
        )}

        {(progress.allApplied || progress.totals.applied > 0) && progress.status !== "reverted" && (
          <button
            type="button"
            onClick={() => setRevertDialogOpen(true)}
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill border border-edge bg-surface px-lg text-[14px] font-medium text-ink transition-colors hover:bg-wash focus-ring"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Revert this import
          </button>
        )}

        <button
          type="button"
          onClick={onDone}
          className="min-h-11 rounded-pill px-lg text-[14px] font-medium text-grey underline underline-offset-4 hover:text-ink focus-ring"
        >
          Start a new import
        </button>
      </div>

      <ActionDialog
        open={revertDialogOpen}
        title="Revert this import?"
        description={`This removes exactly the ${progress.totals.applied} inventory row(s) this session created, across every chunk. Nothing else in your cellar is touched.`}
        confirmLabel="Revert import"
        busy={reverting}
        onConfirm={() => void doRevert()}
        onClose={() => setRevertDialogOpen(false)}
      />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-grey">{label}</dt>
      <dd className="tabular text-[20px] font-medium text-ink">{value}</dd>
    </div>
  );
}
