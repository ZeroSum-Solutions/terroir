"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ClipboardCheck } from "lucide-react";

export function ReconcileQueueMetric() {
  const [count, setCount] = useState<number | "unavailable" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/reconcile-queue", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Queue count failed (${response.status})`);
        return response.json();
      })
      .then((payload: { summary?: { itemCount?: number } } | null) => {
        setCount(typeof payload?.summary?.itemCount === "number" ? payload.summary.itemCount : "unavailable");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setCount("unavailable");
      });
    return () => controller.abort();
  }, []);

  return (
    <div data-metric="reconcile-queue-count" className="mb-lg md:mb-xl">
      <Link href="/reconcile-queue" className="group flex min-h-11 items-center justify-between gap-md rounded-lg border border-hairline bg-bridge-surface px-md py-sm transition-colors hover:bg-beige focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25">
        <span className="flex min-w-0 items-center gap-sm">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-accent/10 text-accent">
            <ClipboardCheck className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </span>
          <span>
            <span className="block text-caption font-medium uppercase text-grey">Reconciliation queue</span>
            <span className="mt-2xs block text-[12px] text-grey">Inventory records needing review</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-sm">
          {/* Data speaks Courier, Bodoni is display-only (DESIGN.md). */}
          <span className="font-mono text-[20px] font-medium tabular text-ink" aria-label={metricLabel(count)}>{metricValue(count)}</span>
          <ArrowUpRight className="h-4 w-4 text-grey transition-colors group-hover:text-accent" aria-hidden />
        </span>
      </Link>
    </div>
  );
}

function metricValue(count: number | "unavailable" | null): string {
  if (count === null) return "—";
  return count === "unavailable" ? "Unavailable" : String(count);
}

function metricLabel(count: number | "unavailable" | null): string {
  if (count === null) return "Loading issue count";
  return count === "unavailable" ? "Issue count unavailable" : `${count} issues`;
}
