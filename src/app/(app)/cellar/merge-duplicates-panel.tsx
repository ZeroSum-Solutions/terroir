"use client";

import { useCallback, useState } from "react";
import type { CellarWineRow } from "./types";
import { wineTitle } from "@/lib/wine-display-name";

type Toast = { success: (text: string) => void; error: (text: string) => void };

/**
 * OPP-1 (EV-1.2) — merge-duplicate panel: manager+ can collapse a
 * same-lineage/vintage/format twin into the wine open in the drawer.
 *
 * `busy`/`setBusy`/`setErrorMsg` are threaded down from the drawer rather
 * than owned locally — the drawer disables merge, pour, undo, 86, and
 * delete together while any one of them is in flight (so two conflicting
 * mutations on the same wine can't race), and the single error banner is
 * shared across all of them too.
 */
export function MergeDuplicatesPanel({
  wineId,
  duplicateRows,
  busy,
  setBusy,
  setErrorMsg,
  toast,
  refresh,
  onMerged,
}: {
  wineId: string;
  duplicateRows: CellarWineRow[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setErrorMsg: (message: string | null) => void;
  toast: Toast;
  refresh: () => void;
  onMerged: () => void;
}) {
  const [mergeConfirm, setMergeConfirm] = useState<string | null>(null);

  const doMerge = useCallback(
    async (sourceId: string) => {
      setErrorMsg(null);
      setBusy(true);
      try {
        const res = await fetch("/api/wines/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The open drawer's wine is kept; the duplicate collapses into it.
          body: JSON.stringify({ source_id: sourceId, target_id: wineId }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(payload?.error?.message ?? `Merge failed (${res.status})`);
        }
        toast.success("Duplicate merged — stock and history combined.");
        setMergeConfirm(null);
        refresh();
        onMerged();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Merge failed.");
      } finally {
        setBusy(false);
      }
    },
    [wineId, setBusy, setErrorMsg, toast, refresh, onMerged],
  );

  if (duplicateRows.length === 0) return null;

  return (
    <div
      data-merge-duplicates
      className="flex flex-col gap-xs rounded-lg border border-risk-ink/30 bg-risk-wash/40 p-sm"
    >
      <p className="text-[13px] font-medium text-ink">
        Possible duplicate record{duplicateRows.length === 1 ? "" : "s"}
      </p>
      <p className="text-[12px] text-grey">
        Same wine, same vintage, same format. Merging combines stock
        and keeps the full history. Different vintages are never
        merged — they stay linked as siblings.
      </p>
      {duplicateRows.map((dup) =>
        mergeConfirm === dup.wine_id ? (
          <div key={dup.wine_id} className="flex gap-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMergeConfirm(null)}
              className="h-11 flex-1 rounded-pill border border-rule bg-surface text-[13px] font-medium text-ink hover:bg-wash disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => doMerge(dup.wine_id)}
              className="h-11 flex-1 rounded-pill bg-primary text-[13px] font-medium text-seal-ink hover:bg-primary-hover disabled:opacity-60"
            >
              {busy ? "Merging..." : "Confirm merge"}
            </button>
          </div>
        ) : (
          <button
            key={dup.wine_id}
            type="button"
            disabled={busy}
            onClick={() => setMergeConfirm(dup.wine_id)}
            className="flex h-11 items-center justify-center rounded-pill border border-edge bg-surface px-sm text-[13px] font-medium text-ink hover:bg-wash disabled:opacity-60"
          >
            Merge &ldquo;{wineTitle(dup.producer, dup.name)}
            {dup.vintage ? ` ${dup.vintage}` : ""}&rdquo; into this record
          </button>
        ),
      )}
    </div>
  );
}
