import Link from "next/link";
import { formatPrice } from "./price-comparison-helpers";
import type { WineComparison } from "./price-comparison-helpers";

// BND-140: summary stats above the comparable-wines table — count, total
// savings opportunity, overpaid-vs-market count, and a link to the single
// biggest savings opportunity.
export function PriceSummaryCard({
  comparable,
  totalSavings,
}: {
  comparable: WineComparison[];
  totalSavings: number;
}) {
  if (comparable.length === 0) return null;

  const overpaidCount = comparable.filter(
    (c) => c.variancePct != null && c.variancePct > 0,
  ).length;
  const topOpportunity = comparable[0];

  return (
    <div className="mb-lg rounded-card card-surface p-lg">
      <div className="flex flex-wrap items-baseline gap-lg">
        <div>
          <div className="text-caption font-medium uppercase text-grey">
            Wines with multiple suppliers
          </div>
          <div className="mt-xs tabular text-subheading font-medium text-ink">
            {comparable.length}
          </div>
        </div>
        {totalSavings > 0 && (
          <div>
            <div className="text-caption font-medium uppercase text-grey">
              Potential savings
            </div>
            <div className="mt-xs tabular text-subheading font-medium text-ready-ink">
              {formatPrice(totalSavings)}
            </div>
          </div>
        )}
        {overpaidCount > 0 && (
          <div>
            <div className="text-caption font-medium uppercase text-grey">
              Overpaid vs market
            </div>
            <div className="mt-xs tabular text-subheading font-medium text-risk-ink">
              {overpaidCount}
            </div>
          </div>
        )}
        {topOpportunity && topOpportunity.potentialSavings > 0 && (
          <Link
            href={`/cellar?wine=${topOpportunity.wine.id}`}
            aria-label={`View top savings opportunity: ${topOpportunity.wine.producer} ${topOpportunity.wine.name} in cellar`}
            className="group min-w-0 max-w-full rounded-md focus-ring"
          >
            <div className="text-caption font-medium uppercase text-grey">
              Top opportunity
            </div>
            <div className="mt-xs tabular text-subheading font-medium text-ready-ink group-hover:text-accent">
              Save {formatPrice(topOpportunity.potentialSavings)}
            </div>
            <div className="mt-2xs truncate text-ledger text-grey group-hover:text-accent">
              {topOpportunity.wine.producer} · {topOpportunity.wine.name}
              {topOpportunity.wine.vintage
                ? ` ${topOpportunity.wine.vintage}`
                : ""}
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}
