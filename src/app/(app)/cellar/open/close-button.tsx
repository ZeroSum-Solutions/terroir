"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { XCircle } from "lucide-react";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { normalizeIsoUtcTimestamp } from "@/lib/api/iso-timestamp";

interface Props {
  bottleId: string;
  openedAt: string;
  remainingOz: number;
}

const closeBottleCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:close-bottle"),
});

/**
 * BND-122 — "Close bottle" button for the /cellar/open page.
 *
 * Shows a two-step confirmation to prevent accidental discards.
 * First click: "Close bottle" → "Confirm discard?"
 * Second click: calls POST /api/open-bottles/[id]/close, refreshes the page.
 */
export function CloseBottleButton({
  bottleId,
  openedAt,
  remainingOz,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const closingRef = useRef(false);
  const confirmationTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const router = useRouter();

  const clearConfirmationTimer = () => {
    if (confirmationTimerRef.current !== null) {
      clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearConfirmationTimer();
    },
    [],
  );

  const handleClose = async () => {
    if (!confirming) {
      setErrorMessage(null);
      setConfirming(true);
      clearConfirmationTimer();
      confirmationTimerRef.current = setTimeout(() => {
        confirmationTimerRef.current = null;
        setConfirming(false);
      }, 5000);
      return;
    }
    if (closingRef.current) return;

    clearConfirmationTimer();
    closingRef.current = true;
    setIsClosing(true);
    try {
      const { response, data } =
        await closeBottleCommands.json<unknown>({
          slot: `close:${bottleId}`,
          url: `/api/open-bottles/${bottleId}/close`,
          method: "POST",
          json: {
            expected_opened_at: normalizeIsoUtcTimestamp(openedAt),
          },
        });
      if (response.ok) {
        setErrorMessage(null);
        setConfirming(false);
        router.refresh();
      } else {
        console.error("Close bottle failed:", data);
        const error = closeBottleError(data);
        setErrorMessage(error.message);
        setConfirming(false);
        if (
          error.code === "stale_open_bottle" ||
          error.code === "already_closed"
        ) {
          router.refresh();
        }
      }
    } catch (error) {
      console.error("Close bottle error:", error);
      setErrorMessage("Could not close the bottle. Try again.");
      setConfirming(false);
    } finally {
      closingRef.current = false;
      setIsClosing(false);
    }
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearConfirmationTimer();
    setConfirming(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-xs">
        {confirming && !isClosing && (
          <button
            type="button"
            onClick={handleCancel}
            className="text-[11px] text-ink-muted hover:text-ink px-2 py-1 rounded-sm transition-colors"
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
            void handleClose();
          }}
          disabled={isClosing}
          className={
            confirming
              ? "inline-flex items-center gap-1.5 text-[11px] font-medium text-error bg-error/10 hover:bg-error/20 px-2.5 py-1 rounded-sm transition-colors"
              : "inline-flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-error px-2 py-1 rounded-sm hover:bg-error/5 transition-colors"
          }
          aria-label={
            isClosing
              ? "Closing bottle"
              : confirming
                ? `Confirm discard ${remainingOz.toFixed(1)} oz`
                : "Close bottle"
          }
        >
          <XCircle className="h-3.5 w-3.5" strokeWidth={2} />
          {isClosing
            ? "Closing..."
            : confirming
              ? `Discard ${remainingOz.toFixed(1)} oz?`
              : "Close"}
        </button>
      </div>
      {errorMessage && (
        <p role="alert" className="max-w-56 text-right text-[11px] text-error">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

function closeBottleError(value: unknown): {
  code: string | null;
  message: string;
} {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null
  ) {
    const code =
      "code" in value.error && typeof value.error.code === "string"
        ? value.error.code
        : null;
    const message =
      "message" in value.error && typeof value.error.message === "string"
        ? value.error.message
        : null;
    if (message) return { code, message };
  }

  return {
    code: null,
    message: "Could not close the bottle. Try again.",
  };
}
