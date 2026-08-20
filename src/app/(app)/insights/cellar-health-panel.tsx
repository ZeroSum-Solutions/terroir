import Link from "next/link";
import type { CellarHealthSegment } from "@/lib/cellar-health/classify";
import type { CellarHealthSummaryItem } from "@/lib/cellar-health/summary";
import { RecomputeCellarHealthButton } from "./recompute-cellar-health-button";

const LABELS: Record<CellarHealthSegment, string> = {
  window_risk: "Window risk",
  hold: "Hold",
  dead_stock: "Dead stock",
  cash_trap: "Cash trap",
  healthy: "Healthy",
};

export function CellarHealthPanel({
  summary,
  canRecompute,
}: {
  summary: CellarHealthSummaryItem[];
  canRecompute: boolean;
}) {
  return (
    <section className="mb-lg md:mb-xl" aria-labelledby="cellar-health-heading">
      <div className="mb-md flex items-center justify-between gap-md">
        <div>
          <h2
            id="cellar-health-heading"
            className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent"
          >
            Cellar health
          </h2>
          <p className="mt-2xs text-[12px] text-ink-muted">
            Stock value and wine count by segment
          </p>
        </div>
        {canRecompute && <RecomputeCellarHealthButton />}
      </div>
      <div className="grid gap-xs rounded-md border border-border bg-surface p-md md:grid-cols-5">
        {summary.map((item) => {
          const href = `/cellar?health=${item.segment}`;
          return (
            <div key={item.segment} className="rounded-sm bg-white p-sm">
              <h3 className="text-[12px] font-medium text-ink">{LABELS[item.segment]}</h3>
              <div className="mt-xs grid grid-cols-2 gap-xs">
                <div data-metric={`cellar-health-${item.segment}-value`}>
                  <Link href={href} className="block rounded-sm hover:bg-surface-muted">
                    <span className="block font-mono text-[18px] text-ink">
                      {formatMoney(item.value)}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.06em] text-ink-subtle">
                      value
                    </span>
                  </Link>
                </div>
                <div data-metric={`cellar-health-${item.segment}-count`}>
                  <Link href={href} className="block rounded-sm hover:bg-surface-muted">
                    <span className="block font-mono text-[18px] text-ink">{item.count}</span>
                    <span className="text-[10px] uppercase tracking-[0.06em] text-ink-subtle">
                      wines
                    </span>
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatMoney(value: number) {
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
