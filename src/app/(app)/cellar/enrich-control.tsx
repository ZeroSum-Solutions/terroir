"use client";

import { useCallback, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAsyncAction } from "./use-async-action";

/**
 * Re-enrichment control. Its busy flag (`enriching`) has never been shared
 * with any other drawer action, so — unlike merge/delete/pour/undo/86,
 * which share one `busy` on purpose — this is a genuine fit for
 * useAsyncAction.
 */
export function EnrichControl({
  wineId,
  setErrorMsg,
  refresh,
}: {
  wineId: string;
  setErrorMsg: (message: string | null) => void;
  refresh: () => void;
}) {
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null);
  const enrichAction = useAsyncAction();

  const doEnrich = useCallback(() => {
    setEnrichMsg(null);
    setErrorMsg(null);
    return enrichAction.run(
      async () => {
        const res = await fetch(`/api/wines/${wineId}/enrich`, {
          method: "POST",
        });
        const payload = (await res.json().catch(() => null)) as
          | { source?: string | null; message?: string; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(payload?.error ?? `Enrichment failed (${res.status}).`);
        }
        if (payload?.source == null) {
          setEnrichMsg(payload?.message ?? "Could not enrich this wine.");
        } else {
          const sourceLabel = payload.source === "claude_inference"
            ? "Claude AI"
            : payload.source === "lwin_fallback"
              ? "LWIN catalog"
              : "rule engine";
          setEnrichMsg(`Enriched via ${sourceLabel}.`);
          refresh();
        }
      },
      {
        fallbackMessage: "Enrichment failed.",
        onError: (message) => setErrorMsg(message),
      },
    );
  }, [wineId, refresh, setErrorMsg, enrichAction]);

  return (
    <div className="flex flex-col gap-xs">
      <button
        type="button"
        disabled={enrichAction.busy}
        onClick={doEnrich}
        className={cn(
          "flex h-11 items-center justify-center gap-xs rounded-pill border text-[13px] font-medium transition-colors disabled:opacity-60",
          enrichMsg
            ? "border-mark/40 bg-mark/10 text-mark"
            : "border-edge bg-surface text-ink hover:bg-wash",
        )}
      >
        {enrichAction.busy ? (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
        ) : enrichMsg ? (
          <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
        ) : (
          <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
        )}
        {enrichAction.busy ? "Enriching..." : enrichMsg ? "Enriched!" : "Re-enrich"}
      </button>
      {enrichMsg && (
        <p className="text-[11px] text-grey">{enrichMsg}</p>
      )}
    </div>
  );
}
