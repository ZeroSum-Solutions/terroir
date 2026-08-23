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
            className="text-caption font-medium uppercase text-grey"
          >
            Pricing plays
          </h2>
          <p className="mt-2xs text-[12px] text-grey">
            Wine-aware actions from margin, movement, market, and pour history
          </p>
        </div>
        {canRecompute && <RecomputePricingRecommendationsButton />}
      </div>

      {recommendations.length === 0 ? (
        <div className="rounded-card border border-dashed border-beige-deep bg-bridge-surface px-lg py-xl text-center">
          <p className="text-[13px] text-grey">
            No pricing plays yet. Recompute after cellar health and pour data are current.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-hairline bg-white">
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
      className="border-b border-hairline last:border-b-0"
    >
      <div className="flex items-center justify-between bg-beige px-md py-sm">
        <h3
          id={`pricing-class-${recommendationClass}`}
          className="text-caption font-medium uppercase text-ink-soft"
        >
          {LABELS[recommendationClass]}
        </h3>
        <span className="tabular text-[11px] text-grey">{rows.length}</span>
      </div>
      <ul className="divide-y divide-hairline bg-white">
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
        className="group min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
      >
        <span className="block truncate font-serif text-[17px] font-medium text-ink group-hover:text-primary">
          {row.wine.producer}, {row.wine.name}
        </span>
        <span className="mt-2xs block text-[11px] font-light text-grey">
          {row.wine.vintage ?? "NV"}
        </span>
      </Link>
      <div>
        <p className="text-[13px] leading-relaxed text-ink">{row.rationale}</p>
        <p className="mt-2xs text-[11px] text-grey">
          {formatEvidence(row)}
        </p>
      </div>
      <div className="md:text-right">
        {row.timing ? (
          <span className="inline-flex rounded-pill bg-powder-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-powder-ink">
            {row.timing}
          </span>
        ) : (
          <span className="text-[11px] text-grey">No timing action</span>
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
