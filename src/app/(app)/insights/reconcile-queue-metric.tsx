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
      <Link href="/reconcile-queue" className="group flex min-h-11 items-center justify-between gap-md rounded-md border border-border bg-surface px-md py-sm transition-colors hover:border-border-strong hover:bg-surface-muted">
        <span className="flex min-w-0 items-center gap-sm">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
            <ClipboardCheck className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </span>
          <span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Reconciliation queue</span>
            <span className="mt-2xs block text-[12px] text-ink-muted">Inventory records needing review</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-sm">
          <span className="font-mono text-[22px] font-medium tabular-nums text-ink" aria-label={metricLabel(count)}>{metricValue(count)}</span>
          <ArrowUpRight className="h-4 w-4 text-ink-subtle transition-colors group-hover:text-accent" aria-hidden />
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
