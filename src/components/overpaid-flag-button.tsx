"use client";

import { useCallback, useState, useTransition } from "react";
import { Flag } from "lucide-react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/api/client-error";

export function OverpaidFlagButton({
  wineId,
  flagged,
}: {
  wineId: string;
  flagged: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    startTransition(async () => {
      setError(null);
      try {
        const response = await fetch(
          `/api/wines/${wineId}/overpaid`,
          { method: "POST" },
        );
        if (!response.ok) {
          setError(
            readApiError(
              await response.json().catch(() => null),
              `Flag update failed (${response.status}).`,
            ).message,
          );
          return;
        }
        router.refresh();
      } catch {
        setError("Flag update failed. Please try again.");
      }
    });
  }, [wineId, router]);

  return (
    <span className="inline-flex flex-col items-center gap-2xs">
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        aria-label={flagged ? "Remove overpaid flag" : "Flag as overpaid"}
        title={
          flagged
            ? "Remove overpaid flag"
            : "Flag as overpaid for follow-up"
        }
        className={
          "inline-flex items-center justify-center rounded-sm p-xs transition-colors " +
          (flagged
            ? "bg-error-soft/50 text-error hover:bg-error-soft hover:text-error-hover"
            : "text-ink-subtle hover:bg-error-soft/30 hover:text-error")
        }
      >
        <Flag
          className={`h-4 w-4 ${isPending ? "animate-pulse" : ""}`}
          strokeWidth={flagged ? 2.5 : 1.5}
          fill={flagged ? "currentColor" : "none"}
        />
      </button>
      {error && (
        <span className="max-w-32 text-[10px] text-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
