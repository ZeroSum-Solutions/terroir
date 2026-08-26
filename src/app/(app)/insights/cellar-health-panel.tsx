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

// Background tint per segment carries the same risk/health meaning as the
// badge system elsewhere (DESIGN.md): window_risk reads as an informational
// window-closing heads-up, hold as a positive appreciating-asset call,
// dead_stock as a plain warning, cash_trap as the "sleepy capital" risk
// case, and healthy stays the quiet neutral default.
const SEGMENT_BG: Record<CellarHealthSegment, string> = {
  window_risk: "bg-powder-wash",
  hold: "bg-sage-wash",
  dead_stock: "bg-amber-wash",
  cash_trap: "bg-blush-wash",
  healthy: "bg-surface",
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
      <div className="grid gap-xs rounded-card card-surface p-md md:grid-cols-5">
        {summary.map((item) => {
          const href = `/cellar?health=${item.segment}`;
          return (
            <div key={item.segment} className={`rounded-lg border border-hairline p-sm ${SEGMENT_BG[item.segment]}`}>
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
