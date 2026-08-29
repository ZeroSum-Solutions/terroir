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

// Wax & Counter (DESIGN.md 2026-08-26): segment tint is an urgency ramp
// on the one accent, not four competing hues. Healthy and hold stay
// quiet neutrals, window risk carries the gold time-marker, and the two
// capital-at-risk segments step up in burgundy intensity.
const SEGMENT_BG: Record<CellarHealthSegment, string> = {
  window_risk: "bg-gold/10",
  hold: "bg-bridge-surface",
  dead_stock: "bg-accent/10",
  cash_trap: "bg-accent/20",
  healthy: "bg-surface",
};

export function CellarHealthPanel({
  summary,
  unscored,
  canRecompute,
}: {
  summary: CellarHealthSummaryItem[];
  unscored?: { count: number; value: number };
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
            <div key={item.segment} className={`rounded-md border border-hairline p-sm ${SEGMENT_BG[item.segment]}`}>
              <h3 className="text-[12px] font-medium text-ink">{LABELS[item.segment]}</h3>
              <div className="mt-xs grid grid-cols-2 gap-xs">
                <div data-metric={`cellar-health-${item.segment}-value`}>
                  <Link href={href} className="block rounded-sm hover:bg-beige">
                    <span className="block font-mono text-[16px] font-medium tabular text-ink">
                      {formatMoney(item.value)}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.06em] text-grey">
                      value
                    </span>
                  </Link>
                </div>
                <div data-metric={`cellar-health-${item.segment}-count`}>
                  <Link href={href} className="block rounded-sm hover:bg-beige">
                    <span className="block font-mono text-[16px] font-medium tabular text-ink">{item.count}</span>
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
      {/* Reconciliation line: segments only cover scored wines, so without
          this a "$0 / 0 wines · Healthy" grid could sit beside a six-figure
          snapshot and read as broken data (Kimi audit 2026-08-26). */}
      {unscored && unscored.count > 0 && (
        <p
          data-metric="cellar-health-unscored"
          className="mt-xs text-[12px] text-grey"
        >
          <span className="font-mono tabular">{unscored.count}</span> wine
          {unscored.count === 1 ? "" : "s"} ·{" "}
          <span className="font-mono tabular">{formatMoney(unscored.value)}</span>{" "}
          not yet scored — recompute to include them.
        </p>
      )}
    </section>
  );
}

function formatMoney(value: number) {
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
