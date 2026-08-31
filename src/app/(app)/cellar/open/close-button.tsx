"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { XCircle } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import { useToast } from "@/lib/toast";

interface Props {
  bottleId: string;
  remainingOz: number;
}

/**
 * BND-122 — "Close bottle" button for the /cellar/open page.
 *
 * Shows a two-step confirmation to prevent accidental discards.
 * First click: "Close bottle" → "Confirm discard?"
 * Second click: calls POST /api/open-bottles/[id]/close, refreshes the page.
 *
 * SD-06: a refused close used to be console.error'd and the confirm state
 * reset — the bottle stayed open, the page did not move, and nothing said
 * why. The failure now reaches the operator through the same toast every
 * other cellar mutation uses (see cellar-list.tsx).
 */
export function CloseBottleButton({ bottleId, remainingOz }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const handleClose = () => {
    if (!confirming) {
      setConfirming(true);
      // Auto-reset after 5 seconds if user doesn't confirm
      setTimeout(() => setConfirming(false), 5000);
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch(`/api/open-bottles/${bottleId}/close`, {
          method: "POST",
        });
        if (res.ok) {
          router.refresh();
        } else {
          const body = await res.json().catch(() => null);
          toast.error(
            readApiError(body, `Couldn't close the bottle (${res.status}).`).message,
          );
          setConfirming(false);
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Couldn't close the bottle.",
        );
        setConfirming(false);
      }
    });
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(false);
  };

  return (
    <div className="flex items-center gap-xs">
      {confirming && (
        <button
          type="button"
          onClick={handleCancel}
          className="min-h-11 min-w-11 rounded-pill px-2 py-1 text-[11px] text-grey transition-colors hover:text-ink"
          aria-label="Cancel close"
        >
          Cancel
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleClose();
        }}
        disabled={isPending}
        className={
          confirming
            ? "inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-pill bg-risk-wash px-2.5 py-1 text-[11px] font-medium text-risk-ink transition-colors hover:bg-risk-wash/70"
            : "inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-pill px-2 py-1 text-[11px] text-grey transition-colors hover:bg-risk-wash/40 hover:text-risk-ink"
        }
        aria-label={confirming ? `Confirm discard ${remainingOz.toFixed(1)} oz` : "Close bottle"}
      >
        <XCircle className="h-3.5 w-3.5" strokeWidth={2} />
        {confirming
          ? `Discard ${remainingOz.toFixed(1)} oz?`
          : isPending
            ? "Closing..."
            : "Close"}
      </button>
    </div>
  );
}
