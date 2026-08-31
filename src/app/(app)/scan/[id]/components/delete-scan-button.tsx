"use client";

// SCAN-04 / decision D6 rules 2 and 3.
//
// Rule 2: delete is explicit and confirmed, chosen by the user, never
// automatic. So this is a two-step control — nothing is sent until the
// operator has read the impact and typed nothing but a second, deliberate
// click on a button that names what it is about to destroy.
//
// Rule 3: the confirmation STATES THE BOTTLE-COUNT IMPACT BEFORE the user
// commits. The counts come from the server component that renders this
// (page.tsx reads inventory_items for this scan), not from a round trip
// the user has to wait for after committing.

import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { readApiError } from "@/lib/api/client-error";

interface DeleteScanButtonProps {
  scanId: string;
  distributor: string;
  /** inventory_items rows this scan created. */
  inventoryRows: number;
  /** Sum of those rows' quantities — the bottle-count impact. */
  bottles: number;
  /** Only an owner or manager may delete; staff see nothing at all. */
  canDelete: boolean;
}

function impactSentence(inventoryRows: number, bottles: number): string {
  if (inventoryRows === 0) {
    return "This invoice has no inventory attached to it, so nothing in your cellar changes. The invoice record itself is removed permanently.";
  }
  const lines = `${inventoryRows} inventory ${inventoryRows === 1 ? "line" : "lines"}`;
  const bottleText = `${bottles} ${bottles === 1 ? "bottle" : "bottles"}`;
  return `Deleting this invoice first removes ${bottleText} across ${lines} from your cellar, then removes the invoice record. Wines already in your catalogue are kept.`;
}

export function DeleteScanButton({
  scanId,
  distributor,
  inventoryRows,
  bottles,
  canDelete,
}: DeleteScanButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/scans/${scanId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(readApiError(body, `Delete failed (${res.status})`).message);
      }
      router.push("/scans");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      Sentry.captureException(e, {
        tags: { surface: "scanner", phase: "delete-scan" },
        extra: { scan_id: scanId },
      });
      setDeleting(false);
    }
  }, [scanId, router]);

  if (!canDelete) return null;

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="flex h-11 min-w-11 items-center justify-center gap-sm rounded-pill border border-edge bg-surface px-md text-body-sm font-medium text-risk-ink hover:bg-risk-wash focus-ring"
      >
        <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        Delete invoice
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="delete-scan-title"
      aria-describedby="delete-scan-impact"
      className="rounded-card border border-rule-strong bg-risk-wash p-md"
    >
      <div className="flex items-start gap-sm">
        <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0 text-risk-ink" aria-hidden="true" />
        <div className="min-w-0">
          <p id="delete-scan-title" className="text-control font-medium text-ink">
            Delete the {distributor} invoice?
          </p>
          <p id="delete-scan-impact" className="mt-xs text-body-sm text-ink-soft">
            {impactSentence(inventoryRows, bottles)}
          </p>
          <p className="mt-xs text-body-sm text-ink-soft">This cannot be undone.</p>
        </div>
      </div>
      <div className="mt-md flex flex-wrap items-center gap-sm">
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={deleting}
          className="flex h-11 items-center justify-center gap-xs rounded-pill bg-primary px-md text-body-sm font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-60"
        >
          {deleting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          )}
          {deleting
            ? "Deleting…"
            : inventoryRows === 0
              ? "Delete invoice"
              : `Remove ${bottles} ${bottles === 1 ? "bottle" : "bottles"} and delete`}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="flex h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-body-sm font-medium text-ink hover:bg-wash focus-ring disabled:opacity-60"
        >
          Keep it
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-sm text-ledger text-risk-ink">
          {error}
        </p>
      )}
    </div>
  );
}
