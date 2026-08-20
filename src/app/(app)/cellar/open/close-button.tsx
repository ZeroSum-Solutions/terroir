"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { XCircle } from "lucide-react";

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
 */
export function CloseBottleButton({ bottleId, remainingOz }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

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
          const body = await res.json().catch(() => ({}));
          console.error("Close bottle failed:", body);
          setConfirming(false);
        }
      } catch (err) {
        console.error("Close bottle error:", err);
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
          className="text-[11px] text-grey hover:text-ink px-2 py-1 rounded-pill transition-colors"
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
            ? "inline-flex items-center gap-1.5 text-[11px] font-medium text-primary bg-blush-wash hover:bg-blush-wash/70 px-2.5 py-1 rounded-pill transition-colors"
            : "inline-flex items-center gap-1.5 text-[11px] text-grey hover:text-primary px-2 py-1 rounded-pill hover:bg-blush-wash/40 transition-colors"
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
