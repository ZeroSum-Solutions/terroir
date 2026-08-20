import Link from "next/link";
import type { PricingPlay } from "@/lib/pricing-recommendations/fetch";
import {
  PRICING_RECOMMENDATION_CLASSES,
  type PricingRecommendationClass,
} from "@/lib/pricing-recommendations/recommend";
import { metricHref } from "./metric-href";
import { RecomputePricingRecommendationsButton } from "./recompute-pricing-recommendations-button";

const LABELS: Record<PricingRecommendationClass, string> = {
  discount_to_move: "Discount to move",
  raise_appreciating: "Raise appreciating",
  feature_btg: "Feature BTG",
  hold: "Hold — no action",
};

export function PricingPlaysSection({
  recommendations,
  canRecompute,
}: {
  recommendations: PricingPlay[];
  canRecompute: boolean;
}) {
  return (
    <section className="mb-lg md:mb-xl" aria-labelledby="pricing-plays-heading">
      <div className="mb-md flex items-center justify-between gap-md">
        <div>
          <h2
            id="pricing-plays-heading"
            className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent"
          >
            Pricing plays
          </h2>
          <p className="mt-2xs text-[12px] text-ink-muted">
            Wine-aware actions from margin, movement, market, and pour history
          </p>
        </div>
        {canRecompute && <RecomputePricingRecommendationsButton />}
      </div>

      {recommendations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-xl text-center">
          <p className="text-[13px] text-ink-muted">
            No pricing plays yet. Recompute after cellar health and pour data are current.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface">
          {PRICING_RECOMMENDATION_CLASSES.map((recommendationClass) => {
            const rows = recommendations.filter(
              (row) => row.class === recommendationClass,
            );
            if (rows.length === 0) return null;
            return (
              <PricingGroup
                key={recommendationClass}
                recommendationClass={recommendationClass}
                rows={rows}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function PricingGroup({
  recommendationClass,
  rows,
}: {
  recommendationClass: PricingRecommendationClass;
  rows: PricingPlay[];
}) {
  return (
    <section
      data-pricing-class={recommendationClass}
      aria-labelledby={`pricing-class-${recommendationClass}`}
      className="border-b border-border last:border-b-0"
    >
      <div className="flex items-center justify-between bg-surface-muted px-md py-sm">
        <h3
          id={`pricing-class-${recommendationClass}`}
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink"
        >
          {LABELS[recommendationClass]}
        </h3>
        <span className="font-mono text-[11px] text-ink-subtle">{rows.length}</span>
      </div>
      <ul className="divide-y divide-dashed divide-border bg-white">
        {rows.map((row) => <PricingRow key={row.wineId} row={row} />)}
      </ul>
    </section>
  );
}

function PricingRow({ row }: { row: PricingPlay }) {
  return (
    <li
      data-metric={`pricing-play-${row.wineId}`}
      className="grid gap-sm px-md py-md md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] md:items-center"
    >
      <Link
        href={metricHref("wine", row.wineId)}
        className="group min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      >
        <span className="block truncate font-serif text-[15px] text-ink group-hover:text-accent">
          {row.wine.producer}, {row.wine.name}
        </span>
        <span className="mt-2xs block font-mono text-[11px] text-ink-subtle">
          {row.wine.vintage ?? "NV"}
        </span>
      </Link>
      <div>
        <p className="text-[13px] leading-relaxed text-ink">{row.rationale}</p>
        <p className="mt-2xs text-[11px] text-ink-muted">
          {formatEvidence(row)}
        </p>
      </div>
      <div className="md:text-right">
        {row.timing ? (
          <span className="inline-flex rounded-sm border border-border-strong bg-surface-muted px-sm py-xs text-[11px] font-semibold text-ink">
            {row.timing}
          </span>
        ) : (
          <span className="text-[11px] text-ink-subtle">No timing action</span>
        )}
      </div>
    </li>
  );
}

function formatEvidence(row: PricingPlay) {
  const evidence = row.evidence;
  const values = [`${evidence.velocity30d} pours / 30d`];
  if (evidence.marginPct !== null) {
    values.push(`${Math.round(evidence.marginPct)}% gross margin`);
  }
  if (evidence.appreciation !== null) {
    values.push(`${formatSignedPercent(evidence.appreciation)} vs cost basis`);
  }
  if (evidence.healthSegment) {
    values.push(`health: ${evidence.healthSegment.replace("_", " ")}`);
  }
  return `Evidence · ${values.join(" · ")}`;
}

function formatSignedPercent(value: number) {
  const percent = Math.round(value * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}
