import Link from "next/link";
import { OverpaidFlagButton } from "@/components/overpaid-flag-button";
import {
  VARIANCE_HIGHLIGHT_THRESHOLD,
  formatInvoiceDate,
  formatPct,
  formatPrice,
  pickMostRecent,
} from "./price-comparison-helpers";
import type { WineComparison } from "./price-comparison-helpers";

// BND-140/BND-138: mobile card layout for wines seen from only one
// distributor — the small-screen counterpart to SingleSourcePriceTable.
export function SingleSourcePriceCards({ wines }: { wines: WineComparison[] }) {
  return (
    <div className="flex flex-col gap-sm md:hidden">
      {wines.map((comp) => {
        const latest = pickMostRecent(comp.prices);
        const latestDate = formatInvoiceDate(latest?.invoiceDate ?? null);
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
            <div className="flex items-start justify-between gap-sm">
              <div className="flex items-start gap-xs min-w-0 flex-1">
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
              <span className="shrink-0 tabular text-control font-medium text-ink">
                {latest ? formatPrice(latest.unitCost) : "—"}
              </span>
            </div>
            {/* BND-138: Market comparison for single-source mobile */}
            {comp.marketPrice != null && (
              <div className="mt-sm flex items-center justify-between border-t border-dashed border-rule pt-sm">
                <span className="text-caption font-medium uppercase text-grey">
                  Market
                </span>
                <div className="flex items-center gap-sm">
                  <span className="text-body-sm text-grey tabular-nums">
                    {formatPrice(comp.marketPrice)}
                  </span>
                  {comp.variancePct != null && Math.abs(comp.variancePct) > VARIANCE_HIGHLIGHT_THRESHOLD && (
                    <span
                      className={`rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${
                        comp.variancePct > 0
                          ? "bg-risk-wash text-risk-ink"
                          : "bg-ready-wash text-ready-ink"
                      }`}
                    >
                      {comp.variancePct > 0 ? "+" : ""}
                      {formatPct(comp.variancePct)}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="mt-sm flex items-baseline justify-between border-t border-dashed border-rule pt-sm text-body-sm text-grey">
              <span className="min-w-0 truncate">
                {latest?.distributor ?? "—"}
              </span>
              {latestDate && (
                <span className="ml-sm shrink-0 text-caption text-grey">
                  {latestDate}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
