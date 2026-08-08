"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { cn } from "@/lib/utils";

/**
 * BND-039 — EnrichCellarButton
 *
 * Owner-only trigger to refresh drink-window data across the whole
 * cellar. Calls `/api/wines/enrich` in a loop until `hasMore: false`,
 * showing a running tally:
 *
 *   "Enriching… 12 done · 3 in progress"
 *
 * The route already does:
 *   • Tier 1 (rule engine, fast, free, ~80% coverage)
 *   • Tier 2 (Claude fallback for rule misses, slower, paid, ~95%
 *     coverage on obscure wines)
 *   • Per-request rate limit (CLAUDE_FALLBACK_MAX_PER_REQUEST = 50)
 *
 * The loop here is what unlocks bulk processing — repeatedly calling
 * the route until the backlog drains.
 */

type EnrichResponse = {
  total: number;
  enriched: number;
  ruleEnrichedCount: number;
  claudeEnrichedCount: number;
  claudeAttemptedCount: number;
  claudeRemaining: number;
  lwinMatched: number;
  hasMore: boolean;
  jobId?: string;
  status?: string;
};

const MAX_LOOP_ITERATIONS = 20; // safety cap — 20 × 2050 = 41k wines max
const enrichCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:wine-enrichment"),
});

export function EnrichCellarButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    iterations: number;
    enriched: number;
    claudeEnriched: number;
    lwinMatched: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onClick = async () => {
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    setProgress({ iterations: 0, enriched: 0, claudeEnriched: 0, lwinMatched: 0 });

    let totalEnriched = 0;
    let totalClaudeEnriched = 0;
    let totalLwinMatched = 0;

    try {
      for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
        const { response, data } = await enrichCommands.json<EnrichResponse>({
          slot: "batch",
          url: "/api/wines/enrich",
          method: "POST",
          json: {},
        });
        if (!response.ok) {
          throw new Error(
            readApiError(data, `Enrich failed (${response.status}).`).message,
          );
        }
        if (response.status === 202) {
          setProgress(null);
          setStatusMsg(
            "Wine enrichment is queued. Progress will appear in Background work.",
          );
          return;
        }
        const body = data;
        totalEnriched += body.enriched;
        totalClaudeEnriched += body.claudeEnrichedCount;
        totalLwinMatched += body.lwinMatched;
        setProgress({
          iterations: i + 1,
          enriched: totalEnriched,
          claudeEnriched: totalClaudeEnriched,
          lwinMatched: totalLwinMatched,
        });
        if (!body.hasMore) break;
      }
      // Re-render server components so the Cellar list and Insights
      // alerts pick up the freshly-enriched wines.
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Enrich failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-xs">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={cn(
          "inline-flex h-[40px] items-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-bg-secondary disabled:opacity-60",
          busy && "cursor-wait",
        )}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
        ) : (
          <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
        )}
        {busy ? "Enriching…" : "Refresh drink-window data"}
      </button>

      {progress && (
        <p className="text-[12px] text-ink-muted">
          {progress.enriched} wine{progress.enriched === 1 ? "" : "s"} enriched
          {progress.claudeEnriched > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="font-mono">{progress.claudeEnriched}</span> via
              Claude AI
            </>
          )}
          {progress.lwinMatched > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="font-mono">{progress.lwinMatched}</span> LWIN
              matched
            </>
          )}
        </p>
      )}

      {errorMsg && (
        <p role="alert" className="text-[12px] text-error">
          {errorMsg}
        </p>
      )}

      {statusMsg && (
        <p role="status" className="text-[12px] text-ink-muted">
          {statusMsg}
        </p>
      )}
    </div>
  );
}
