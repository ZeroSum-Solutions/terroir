"use client";

import * as Sentry from "@sentry/nextjs";
import { RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { readApiError } from "@/lib/api/client-error";

interface ReExtractButtonProps {
  scanId: string;
}

export function ReExtractButton({ scanId }: ReExtractButtonProps) {
  const [reExtracting, setReExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setReExtracting(true);
    setError(null);
    try {
      const res = await fetch(`/api/scans/${scanId}/re-extract`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(
          readApiError(body, `Re-extraction failed (${res.status})`).message,
        );
      }
      window.location.reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Re-extraction failed";
      setError(msg);
      Sentry.captureException(e, {
        tags: { surface: "scanner", phase: "re-extract" },
        extra: { scan_id: scanId },
      });
    } finally {
      setReExtracting(false);
    }
  }, [scanId]);

  return (
    <div className="flex flex-col items-start gap-sm">
      <button
        type="button"
        onClick={handleClick}
        disabled={reExtracting}
        className="flex h-11 min-w-11 items-center justify-center gap-sm rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink disabled:opacity-50 hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        title="Re-run Claude extraction on the stored OCR text"
      >
        <RefreshCw
          className={`h-4 w-4${reExtracting ? " animate-spin" : ""}`}
          strokeWidth={2}
          aria-hidden="true"
        />
        {reExtracting ? "Re-extracting…\n" : <span className="hidden sm:inline">Re-run extraction</span>}
      </button>
      {error && (
        <p className="text-[12px] text-accent">{error}</p>
      )}
    </div>
  );
}
