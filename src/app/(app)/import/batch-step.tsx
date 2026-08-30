"use client";

// The single-batch step: apply, per-row resolution, revert, and the
// reverted-batch banner. Extracted verbatim from import-client.tsx, which
// re-exports BatchStep unchanged.

import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { ActionDialog } from "@/components/action-dialog";
import type { BatchDetail, BatchSummary } from "@/domains/import/batch-api-types";
import { summarizeRevertResult, type RevertResult } from "@/domains/import/revert-summary";
import { loadBatchDetail } from "./load-batch-detail";
import { SummaryStat } from "./summary-stat";

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
          className="mt-lg flex min-h-11 w-full items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-seal-ink transition-colors hover:bg-primary-hover focus-ring"
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
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-risk-ink">
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
              <li key={row.id} className="rounded-card card-surface p-sm">
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
                      className="min-h-11 w-28 rounded-pill border border-rule bg-surface px-sm text-[14px] focus:border-accent focus-ring"
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
                    className="min-h-11 rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Include anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveRow(row.id, "exclude")}
                    className="min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
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
            className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-seal-ink transition-colors hover:bg-primary-hover focus-ring disabled:cursor-not-allowed disabled:opacity-60"
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
    <span className="inline-flex items-center gap-2xs rounded-pill bg-wash px-sm py-2xs text-caption font-medium text-ink">
      {status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </span>
  );
}
