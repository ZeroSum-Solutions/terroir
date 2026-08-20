"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";
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
};

const MAX_LOOP_ITERATIONS = 20; // safety cap — 20 × 2050 = 41k wines max

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
  const [, startTransition] = useTransition();

  const onClick = async () => {
    setBusy(true);
    setErrorMsg(null);
    setProgress({ iterations: 0, enriched: 0, claudeEnriched: 0, lwinMatched: 0 });

    let totalEnriched = 0;
    let totalClaudeEnriched = 0;
    let totalLwinMatched = 0;

    try {
      for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
        const res = await fetch("/api/wines/enrich", { method: "POST" });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(payload?.error ?? `Enrich failed (${res.status}).`);
        }
        const body = (await res.json()) as EnrichResponse;
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
          "inline-flex h-[40px] items-center gap-xs rounded-pill border border-ink/25 bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface disabled:opacity-60",
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
        <p className="text-[12px] text-grey">
          {progress.enriched} wine{progress.enriched === 1 ? "" : "s"} enriched
          {progress.claudeEnriched > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="tabular">{progress.claudeEnriched}</span> via
              Claude AI
            </>
          )}
          {progress.lwinMatched > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="tabular">{progress.lwinMatched}</span> LWIN
              matched
            </>
          )}
        </p>
      )}

      {errorMsg && (
        <p role="alert" className="text-[12px] text-primary">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
