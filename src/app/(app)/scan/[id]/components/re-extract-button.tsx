"use client";

import * as Sentry from "@sentry/nextjs";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "@/lib/api/idempotency-client";

interface ReExtractButtonProps {
  scanId: string;
}

const reExtractCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:scan-reextract"),
});

const PROVEN_NON_COMMIT_CODES = new Set([
  "not_found",
  "missing_ocr_text",
  "invalid_ocr_text",
  "parse_failed",
  "validation_failed",
  "rate_limited",
  "bad_input",
  "bad_gateway",
  "no_wines_extracted",
]);

export function ReExtractButton({ scanId }: ReExtractButtonProps) {
  const router = useRouter();
  const [reExtracting, setReExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reExtractingRef = useRef(false);

  const handleClick = useCallback(async () => {
    if (reExtractingRef.current) return;
    reExtractingRef.current = true;
    setReExtracting(true);
    setError(null);
    try {
      const slot = `reextract:${scanId}`;
      const { response, data } =
        await reExtractCommands.json<unknown>({
          slot,
          url: `/api/scans/${scanId}/re-extract`,
          method: "POST",
          json: null,
        });
      if (!response.ok) {
        const code = readApiErrorCode(data);
        if (code !== null && PROVEN_NON_COMMIT_CODES.has(code)) {
          // These responses are produced before the scan update. The next
          // user attempt is a new extraction command, even for transient
          // provider failures that the generic client conservatively retains.
          reExtractCommands.abandon(slot);
        } else if (
          shouldRetainIdempotencyKey(response.status, code)
        ) {
          setError(
            "Re-extraction outcome is unknown. The scan was refreshed; retrying will use the same command.",
          );
          router.refresh();
          return;
        }
        setError(
          readApiError(
            data,
            `Re-extraction failed (${response.status})`,
          ).message,
        );
        return;
      }
      window.location.reload();
    } catch (caught) {
      setError(
        "Re-extraction outcome is unknown. The scan was refreshed; retrying will use the same command.",
      );
      Sentry.captureException(caught, {
        tags: { surface: "scanner", phase: "re-extract" },
        extra: { scan_id: scanId },
      });
      router.refresh();
    } finally {
      reExtractingRef.current = false;
      setReExtracting(false);
    }
  }, [router, scanId]);

  return (
    <div className="flex flex-col items-start gap-sm">
      <button
        type="button"
        onClick={handleClick}
        disabled={reExtracting}
        className="flex h-10 items-center justify-center gap-sm rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink disabled:opacity-50 hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 md:h-[38px]"
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
        <p className="text-[12px] text-danger">{error}</p>
      )}
    </div>
  );
}
