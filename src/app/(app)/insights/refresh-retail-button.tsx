"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DollarSign, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * BND-040 — RefreshRetailButton
 *
 * Owner+manager trigger to refresh Wine-Searcher retail data across the
 * cellar. Calls /api/wines/refresh-retail-batch in a loop until
 * hasMore=false, showing a running tally:
 *
 *   "Refreshing… 12 refreshed · 3 unavailable"
 *
 * The route already enforces:
 *   • Tier 1 (LWIN-keyed Wine-Searcher lookup, sanity-filtered)
 *   • Per-request rate limit (50 wines/call, concurrency 5)
 *   • Stale-only filter (skip wines with retail_refreshed_at < 7d ago)
 *
 * The loop here unlocks bulk processing: repeat-call until backlog drains.
 *
 * Architect-review finding 8: Phase 1 ships its own consumer so the
 * Wine-Searcher client + endpoints get real-traffic validation before
 * Phase 2 wires the drawer.
 */

type RefreshResponse = {
  total: number;
  refreshed: number;
  skipped: number;
  hasMore: boolean;
};

const MAX_LOOP_ITERATIONS = 20; // safety cap — 20 × 50 = 1000 wines max

export function RefreshRetailButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    iterations: number;
    refreshed: number;
    skipped: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onClick = async () => {
    setBusy(true);
    setErrorMsg(null);
    setProgress({ iterations: 0, refreshed: 0, skipped: 0 });

    let totalRefreshed = 0;
    let totalSkipped = 0;

    try {
      for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
        const res = await fetch("/api/wines/refresh-retail-batch", { method: "POST" });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(payload?.error ?? `Refresh failed (${res.status}).`);
        }
        const body = (await res.json()) as RefreshResponse;
        totalRefreshed += body.refreshed;
        totalSkipped += body.skipped;
        setProgress({
          iterations: i + 1,
          refreshed: totalRefreshed,
          skipped: totalSkipped,
        });
        if (!body.hasMore) break;
      }
      // Re-render server components so the cellar drawer + pricing review
      // pick up the freshly-refreshed wines.
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Refresh failed.");
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
          <DollarSign className="h-4 w-4" strokeWidth={2} aria-hidden />
        )}
        {busy ? "Refreshing retail data…" : "Refresh retail data"}
      </button>

      {progress && (
        <p className="text-[12px] text-ink-muted">
          {progress.refreshed} wine{progress.refreshed === 1 ? "" : "s"} refreshed
          {progress.skipped > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="font-mono">{progress.skipped}</span> unavailable
              <span className="ml-xs text-ink-subtle">(no LWIN match or out of API quota)</span>
            </>
          )}
        </p>
      )}

      {errorMsg && (
        <p role="alert" className="text-[12px] text-error">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
