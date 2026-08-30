"use client";

// Pending-row resolution for a chunked import session: the bulk
// include/exclude panel and the per-row list sourced across every chunk
// that still has a pending row. Extracted verbatim from session-step.tsx's
// own JSX — SessionStep still owns every piece of state and every request
// these controls drive, and passes them straight through.

import type { Dispatch, SetStateAction } from "react";
import { Loader2 } from "lucide-react";
import type { BatchRow } from "@/domains/import/batch-api-types";
import type { SessionProgress } from "./session-progress-types";

export type PendingSessionRow = { batchId: string; chunkIndex: number | null; row: BatchRow };

export function SessionPendingRows({
  progress,
  allPendingRows,
  bulkResolving,
  bulkResolve,
  manualCostDrafts,
  setManualCostDrafts,
  resolveRow,
}: {
  progress: SessionProgress;
  allPendingRows: PendingSessionRow[];
  bulkResolving: boolean;
  bulkResolve: (action: "include" | "exclude") => Promise<void>;
  manualCostDrafts: Record<string, string>;
  setManualCostDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  resolveRow: (
    batchId: string,
    rowId: string,
    action: "include" | "exclude",
    manualUnitCost?: number,
  ) => Promise<void>;
}) {
  return (
    <>
      {progress.totals.pending > 1 && progress.status !== "reverted" && (
        <div className="mt-lg rounded-md bg-wash px-md py-sm">
          <p className="text-[13px] text-ink">
            {progress.totals.pending.toLocaleString()} rows need a decision — most are simply
            wines outside the LWIN catalog.
          </p>
          <div className="mt-sm flex flex-wrap items-center gap-sm">
            <button
              type="button"
              disabled={bulkResolving}
              onClick={() => void bulkResolve("include")}
              className="flex min-h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink transition-colors hover:bg-primary-hover focus-ring disabled:cursor-not-allowed disabled:opacity-60"
            >
              {bulkResolving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Include all with a cost
            </button>
            <button
              type="button"
              disabled={bulkResolving}
              onClick={() => void bulkResolve("exclude")}
              className="min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring disabled:cursor-not-allowed disabled:opacity-60"
            >
              Exclude all pending
            </button>
          </div>
          <p className="mt-xs text-caption text-grey">
            Rows missing a unit cost are never bulk-included — they stay listed below for an
            explicit cost.
          </p>
        </div>
      )}

      {allPendingRows.length > 0 && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
            Needs your decision ({allPendingRows.length})
          </h3>
          <ul className="mt-xs space-y-sm">
            {allPendingRows.map(({ batchId, chunkIndex, row }) => (
              <li key={row.id} className="rounded-card card-surface p-sm">
                <p className="text-[14px] text-ink">
                  Chunk {chunkIndex ?? "—"}, row {row.row_number}: {row.raw.producer ? `${row.raw.producer} — ` : ""}{row.raw.name}
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
                      void resolveRow(batchId, row.id, "include", manualUnitCost);
                    }}
                    disabled={row.cost_status === "missing" && !manualCostDrafts[row.id]}
                    className="min-h-11 rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Include anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveRow(batchId, row.id, "exclude")}
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
    </>
  );
}
