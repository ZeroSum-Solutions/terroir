import Link from "next/link";
import type { PricingPlay } from "@/lib/pricing-recommendations/fetch";
import {
  PRICING_RECOMMENDATION_CLASSES,
  type PricingRecommendationClass,
} from "@/lib/pricing-recommendations/recommend";
import { StatusChip } from "@/components/status-chip";
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
  recomputeBlockedReason,
}: {
  recommendations: PricingPlay[];
  canRecompute: boolean;
  recomputeBlockedReason?: string;
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
            Price moves based on how your wines sell
          </p>
        </div>
        {canRecompute && (
          <RecomputePricingRecommendationsButton
            blockedReason={recomputeBlockedReason}
          />
        )}
      </div>

      {recommendations.length === 0 ? (
        /* Two quiet lines, not a full-height dashed box — an empty module
           must never outweigh populated ones (Kimi audit 2026-08-26). */
        <p className="rounded-card card-surface px-md py-sm text-[13px] text-grey">
          No pricing plays yet — they appear once cellar health and pour data
          are current.
        </p>
      ) : (
        <div className="overflow-hidden rounded-card card-surface">
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
      className="border-b border-rule last:border-b-0"
    >
      <div className="flex items-center justify-between bg-surface-sunken px-md py-sm">
        <h3
          id={`pricing-class-${recommendationClass}`}
          className="text-caption font-medium uppercase text-ink-soft"
        >
          {LABELS[recommendationClass]}
        </h3>
        <span className="tabular text-[11px] text-grey">{rows.length}</span>
      </div>
      <ul className="divide-y divide-rule bg-surface">
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
        className="group min-w-0 rounded-sm focus-ring"
      >
        <span className="block truncate font-serif text-[17px] font-medium text-ink group-hover:text-accent">
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
          <StatusChip tone="attention">{row.timing}</StatusChip>
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
