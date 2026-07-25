"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Flag } from "lucide-react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  IdempotentCommandBusyError,
} from "@/lib/api/idempotency-client";

const overpaidFlagCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence(
    "terroir:wine-overpaid-flags",
  ),
});

function overpaidSlot(wineId: string, fromFlagged: boolean): string {
  return `overpaid:${wineId}:from:${fromFlagged ? "flagged" : "clear"}`;
}

export function OverpaidFlagButton({
  wineId,
  flagged,
}: {
  wineId: string;
  flagged: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isBusy, setIsBusy] = useState(false);
  const [settledGeneration, setSettledGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const inFlightRef = useRef(false);
  const previousStateRef = useRef({ wineId, flagged });

  useEffect(() => {
    const previous = previousStateRef.current;
    if (previous.wineId !== wineId || previous.flagged !== flagged) {
      if (inFlightRef.current) return;
      try {
        overpaidFlagCommands.abandon(
          overpaidSlot(previous.wineId, previous.flagged),
        );
      } catch (caught) {
        if (caught instanceof IdempotentCommandBusyError) return;
        throw caught;
      }
      previousStateRef.current = { wineId, flagged };
      busyRef.current = false;
      const timer = setTimeout(() => setIsBusy(false), 0);
      return () => clearTimeout(timer);
    }
  }, [flagged, settledGeneration, wineId]);

  const toggle = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    inFlightRef.current = true;
    setIsBusy(true);
    setError(null);
    try {
      const { response, data } =
        await overpaidFlagCommands.json<unknown>({
          slot: overpaidSlot(wineId, flagged),
          url: `/api/wines/${wineId}/overpaid`,
          method: "POST",
        });
      if (!response.ok) {
        setError(
          readApiError(
            data,
            `Flag update failed (${response.status}).`,
          ).message,
        );
        busyRef.current = false;
        setIsBusy(false);
        startTransition(() => router.refresh());
        return;
      }
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Flag update failed. Please try again.",
      );
      busyRef.current = false;
      setIsBusy(false);
      startTransition(() => router.refresh());
    } finally {
      inFlightRef.current = false;
      setSettledGeneration((generation) => generation + 1);
    }
  }, [flagged, wineId, router]);

  return (
    <span className="inline-flex flex-col items-center gap-2xs">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={isPending || isBusy}
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
          className={`h-4 w-4 ${isPending || isBusy ? "animate-pulse" : ""}`}
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
