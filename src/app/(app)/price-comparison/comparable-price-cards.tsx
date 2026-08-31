import { ArrowDown } from "lucide-react";
import { WineThumb } from "@/components/wine-thumb";
import Link from "next/link";
import { OverpaidFlagButton } from "@/components/overpaid-flag-button";
import {
  VARIANCE_HIGHLIGHT_THRESHOLD,
  formatInvoiceDate,
  formatPct,
  formatPrice,
  latestPriceByDistributor,
} from "./price-comparison-helpers";
import type { WineComparison } from "./price-comparison-helpers";

// BND-140/BND-138: mobile card layout for wines with 2+ distributors —
// the small-screen counterpart to ComparablePriceTable.
export function ComparablePriceCards({ wines }: { wines: WineComparison[] }) {
  return (
    <div className="flex flex-col gap-md md:hidden">
      {wines.map((comp) => {
        const distPrices = latestPriceByDistributor(comp.prices);

        return (
          <div
            key={comp.wine.id}
            className={`rounded-card p-md ${
              comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                ? "border border-risk-ink/30 bg-risk-wash/20"
                : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                  ? "border border-ready/30 bg-ready-wash/10"
                  : "card-surface"
            }`}
          >
            <div className="mb-sm flex items-start justify-between">
              <div className="flex items-start gap-xs min-w-0 flex-1">
                <WineThumb
                  src={comp.wine.hero_image_url}
                  producer={comp.wine.producer}
                  name={comp.wine.name}
                  colour={comp.wine.colour}
                  size={40}
                />
                <Link
                  href={`/cellar?wine=${comp.wine.id}`}
                  aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                  className="group min-w-0 flex-1 rounded-md focus-ring"
                >
                  <div className="font-serif text-body-lg font-medium text-ink group-hover:text-accent">
                    {comp.wine.name}
                    {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                  </div>
                  <div className="text-body-sm text-grey group-hover:text-accent">
                    {comp.wine.producer}
                  </div>
                </Link>
                <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
              </div>
              <div className="flex flex-col items-end gap-xs">
                {comp.spread >= 0.1 && (
                  <span className="inline-flex items-center gap-xs rounded-pill bg-risk-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-risk-ink">
                    {Math.round(comp.spread * 100)}%
                  </span>
                )}
                {comp.potentialSavings > 0 && (
                  <span className="tabular text-caption font-medium text-ready-ink">
                    Save {formatPrice(comp.potentialSavings)}
                  </span>
                )}
              </div>
            </div>

            {/* BND-138: Market comparison row */}
            <div className="mb-sm flex items-center justify-between rounded-md bg-wash px-sm py-sm">
              <span className="text-caption font-medium uppercase text-grey">
                Last paid
              </span>
              <span className="text-control font-medium text-ink tabular-nums">
                {comp.lastPaid > 0 ? formatPrice(comp.lastPaid) : "—"}
              </span>
              {comp.marketPrice != null && (
                <>
                  <span className="mx-xs text-grey">vs</span>
                  <span className="text-control font-medium text-grey tabular-nums">
                    {formatPrice(comp.marketPrice)}
                  </span>
                  {comp.variancePct != null && Math.abs(comp.variancePct) > VARIANCE_HIGHLIGHT_THRESHOLD && (
                    <span
                      className={`ml-sm rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${
                        comp.variancePct > 0
                          ? "bg-risk-wash text-risk-ink"
                          : "bg-ready-wash text-ready-ink"
                      }`}
                    >
                      {comp.variancePct > 0 ? "+" : ""}
                      {formatPct(comp.variancePct)}
                    </span>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col gap-xs">
              {distPrices.map((price) => (
                <div
                  key={price.distributor}
                  className={`flex items-center justify-between rounded-pill px-sm py-xs ${
                    price.unitCost === comp.cheapest
                      ? "bg-ready-wash/40"
                      : ""
                  }`}
                >
                  <span className="min-w-0 text-body-sm text-ink">
                    <span className="block truncate">{price.distributor}</span>
                    {formatInvoiceDate(price.invoiceDate) && (
                      <span className="mt-2xs block text-caption text-grey">
                        {formatInvoiceDate(price.invoiceDate)}
                      </span>
                    )}
                  </span>
                  <span className="tabular text-body-sm font-medium text-ink">
                    {formatPrice(price.unitCost)}
                    {price.unitCost === comp.cheapest && distPrices.length > 1 && (
                      <ArrowDown className="ml-xs inline h-3 w-3 text-ready-ink" strokeWidth={2.5} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
