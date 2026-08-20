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
            className="text-caption font-medium uppercase text-grey"
          >
            Cellar health
          </h2>
          <p className="mt-2xs text-[12px] text-grey">
            Stock value and wine count by segment
          </p>
        </div>
        {canRecompute && <RecomputeCellarHealthButton />}
      </div>
      <div className="grid gap-xs rounded-card border border-hairline bg-white p-md md:grid-cols-5">
        {summary.map((item) => {
          const href = `/cellar?health=${item.segment}`;
          return (
            <div key={item.segment} className="rounded-lg border border-hairline bg-bridge-surface p-sm">
              <h3 className="text-[12px] font-medium text-ink">{LABELS[item.segment]}</h3>
              <div className="mt-xs grid grid-cols-2 gap-xs">
                <div data-metric={`cellar-health-${item.segment}-value`}>
                  <Link href={href} className="block rounded-sm hover:bg-beige">
                    <span className="block font-serif text-[18px] font-normal text-ink">
                      {formatMoney(item.value)}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.06em] text-grey">
                      value
                    </span>
                  </Link>
                </div>
                <div data-metric={`cellar-health-${item.segment}-count`}>
                  <Link href={href} className="block rounded-sm hover:bg-beige">
                    <span className="block font-serif text-[18px] font-normal text-ink">{item.count}</span>
                    <span className="text-[10px] uppercase tracking-[0.06em] text-grey">
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
