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

// BND-140/BND-138: desktop table for wines seen from only one distributor —
// no spread/savings columns since there's nothing to compare against.
export function SingleSourcePriceTable({ wines }: { wines: WineComparison[] }) {
  return (
    <div className="hidden overflow-hidden rounded-card card-surface md:block">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="bg-wash text-caption font-medium uppercase text-grey">
            <th scope="col" className="px-md py-sm text-left font-medium">Wine</th>
            <th scope="col" className="px-md py-sm text-left font-medium">Distributor</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Unit cost</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Market</th>
            <th scope="col" className="px-md py-sm text-right font-medium">Variance</th>
          </tr>
        </thead>
        <tbody>
          {wines.map((comp) => {
            const latest = pickMostRecent(comp.prices);
            const latestDate = formatInvoiceDate(latest?.invoiceDate ?? null);
            return (
              <tr
                key={comp.wine.id}
                className={`border-t border-dashed border-rule ${
                  comp.variancePct != null && comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD
                    ? "bg-risk-wash/25"
                    : comp.variancePct != null && comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD
                      ? "bg-ready-wash/15"
                      : ""
                }`}
              >
                <td className="px-md py-sm">
                  <div className="flex items-start gap-xs">
                    <Link
                      href={`/cellar?wine=${comp.wine.id}`}
                      aria-label={`View ${comp.wine.producer} ${comp.wine.name} in cellar`}
                      className="group inline-block min-w-0 rounded-md focus-ring"
                    >
                      <span className="font-serif text-body-lg font-medium text-ink group-hover:text-accent">
                        {comp.wine.producer}
                      </span>
                      <span className="font-serif text-body-lg text-grey group-hover:text-accent">
                        {" "}
                        {comp.wine.name}
                        {comp.wine.vintage ? ` ${comp.wine.vintage}` : ""}
                      </span>
                    </Link>
                    <OverpaidFlagButton wineId={comp.wine.id} flagged={comp.flagged} />
                  </div>
                </td>
                <td className="px-md py-sm text-grey">
                  <div>{latest?.distributor ?? "—"}</div>
                  {latestDate && (
                    <div className="mt-2xs text-caption text-grey">
                      {latestDate}
                    </div>
                  )}
                </td>
                <td className="px-md py-sm text-right tabular text-ink">
                  {latest ? formatPrice(latest.unitCost) : "—"}
                </td>
                {/* BND-138: Market Price */}
                <td className="px-md py-sm text-right tabular text-ink">
                  {comp.marketPrice != null
                    ? formatPrice(comp.marketPrice)
                    : <span className="text-grey">—</span>}
                </td>
                {/* BND-138: Variance */}
                <td className="px-md py-sm text-right tabular">
                  {comp.variancePct != null ? (
                    comp.variancePct > VARIANCE_HIGHLIGHT_THRESHOLD ? (
                      <span className="inline-flex items-center gap-xs rounded-pill bg-risk-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-risk-ink">
                        +{formatPct(comp.variancePct)}
                      </span>
                    ) : comp.variancePct < -VARIANCE_HIGHLIGHT_THRESHOLD ? (
                      <span className="inline-flex items-center gap-xs rounded-pill bg-ready-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-ready-ink">
                        {formatPct(comp.variancePct)}
                      </span>
                    ) : (
                      <span className="tabular text-grey">{formatPct(comp.variancePct)}</span>
                    )
                  ) : (
                    <span className="text-grey">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
