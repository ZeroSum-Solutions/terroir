import { ArrowDown, ArrowUp, TrendingDown, TrendingUp } from "lucide-react";
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
import { wineDisplayName } from "@/lib/wine-display-name";

// BND-140/BND-138: desktop table for wines with 2+ distributors — one row
// per distributor price, with the wine, spread and savings columns spanning
// all of a wine's rows.
export function ComparablePriceTable({ wines }: { wines: WineComparison[] }) {
  return (
    <div className="hidden md:block overflow-hidden rounded-card card-surface">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="bg-wash text-caption font-medium uppercase text-grey">
            <th scope="col" className="px-md py-sm text-left font-medium">Wine</th>
            <th scope="col" className="px-md py-sm text-left font-medium">Distributor</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Unit cost</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Qty</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Spread</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Savings</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Last paid</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Market</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Variance</th>
          </tr>
        </thead>
        <tbody>
          {wines.map((comp) => {
            const distPrices = latestPriceByDistributor(comp.prices);

            return distPrices.map((price, i) => (
              <tr
                key={`${comp.wine.id}-${price.distributor}-${i}`}
                className={`border-t border-dashed border-rule ${
                  price.unitCost === comp.cheapest
                    ? "bg-ready-wash/40"
                    : comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                      ? "bg-risk-wash/25"
                      : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                        ? "bg-ready-wash/15"
                        : ""
                }`}
              >
                {i === 0 ? (
                  <td className="px-md py-sm align-top" rowSpan={distPrices.length}>
                    <div className="flex items-start gap-xs">
                      <WineThumb
                        src={comp.wine.hero_image_url}
                        producer={comp.wine.producer}
                        name={comp.wine.name}
                        colour={comp.wine.colour}
                        size={36}
                      />
                      <Link
                        href={`/cellar?wine=${comp.wine.id}`}
                        aria-label={`View ${comp.wine.producer} ${wineDisplayName(comp.wine.producer, comp.wine.name)} in cellar`}
                        className="group block min-w-0 flex-1 rounded-md focus-ring"
                      >
                        <div className="font-serif text-body-lg font-medium text-ink group-hover:text-accent">
                          {comp.wine.producer}
                        </div>
                        <div className="text-grey group-hover:text-accent">
                          {wineDisplayName(comp.wine.producer, comp.wine.name)}
                          {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                        </div>
                      </Link>
                      <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
                    </div>
                  </td>
                ) : null}
                <td className="px-md py-sm text-ink">
                  <div>{price.distributor}</div>
                  {formatInvoiceDate(price.invoiceDate) && (
                    <div className="mt-2xs text-caption text-grey">
                      {formatInvoiceDate(price.invoiceDate)}
                    </div>
                  )}
                </td>
                <td className="px-md py-sm text-right tabular text-ink">
                  {formatPrice(price.unitCost)}
                  {price.unitCost === comp.cheapest && distPrices.length > 1 && (
                    <span className="ml-xs inline-flex items-center text-ready-ink">
                      <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
                    </span>
                  )}
                  {price.unitCost === comp.mostExpensive && distPrices.length > 1 && (
                    <span className="ml-xs inline-flex items-center text-risk-ink">
                      <ArrowUp className="h-3 w-3" strokeWidth={2.5} />
                    </span>
                  )}
                </td>
                <td className="px-md py-sm text-right tabular text-grey">
                  {price.quantity}
                </td>
                {i === 0 ? (
                  <td className="px-md py-sm text-right align-top" rowSpan={distPrices.length}>
                    {comp.spread >= 0.1 ? (
                      <span className="inline-flex items-center gap-xs rounded-pill bg-risk-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-risk-ink">
                        {Math.round(comp.spread * 100)}% spread
                      </span>
                    ) : (
                      <span className="tabular text-ledger text-grey">
                        {Math.round(comp.spread * 100)}%
                      </span>
                    )}
                  </td>
                ) : null}
                {i === 0 ? (
                  <td className="px-md py-sm text-right align-top tabular text-ready-ink" rowSpan={distPrices.length}>
                    {comp.potentialSavings > 0
                      ? formatPrice(comp.potentialSavings)
                      : <span className="text-grey">—</span>}
                  </td>
                ) : null}
                {/* BND-138: Last Paid */}
                {i === 0 ? (
                  <td className="px-md py-sm text-right align-top tabular text-ink" rowSpan={distPrices.length}>
                    {comp.lastPaid > 0
                      ? formatPrice(comp.lastPaid)
                      : <span className="text-grey">—</span>}
                  </td>
                ) : null}
                {/* BND-138: Market Price */}
                {i === 0 ? (
                  <td className="px-md py-sm text-right align-top tabular text-ink" rowSpan={distPrices.length}>
                    {comp.marketPrice != null
                      ? formatPrice(comp.marketPrice)
                      : <span className="text-grey">—</span>}
                  </td>
                ) : null}
                {/* BND-138: Variance */}
                {i === 0 ? (
                  <td className="px-md py-sm text-right align-top tabular" rowSpan={distPrices.length}>
                    {comp.variancePct != null ? (
                      comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD ? (
                        <span className="inline-flex items-center gap-xs rounded-pill bg-risk-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-risk-ink">
                          <TrendingUp className="h-3 w-3" strokeWidth={2.5} />
                          +{formatPct(comp.variancePct)}
                        </span>
                      ) : comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD ? (
                        <span className="inline-flex items-center gap-xs rounded-pill bg-ready-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-ready-ink">
                          <TrendingDown className="h-3 w-3" strokeWidth={2.5} />
                          {formatPct(comp.variancePct)}
                        </span>
                      ) : (
                        <span className="tabular text-grey">{formatPct(comp.variancePct)}</span>
                      )
                    ) : (
                      <span className="text-grey">—</span>
                    )}
                  </td>
                ) : null}
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}
