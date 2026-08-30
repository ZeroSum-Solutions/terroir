"use client";

import { ML_PER_OZ } from "@/lib/units";
import { PriceBand } from "@/components/price-band";
import {
  formatPricingStatusLabel,
  getBottleStatus,
  getGlassStatus,
  getMarkupRatio,
  getPourCostPct,
  isRetailStale,
  resolveMarkupTarget,
  resolvePourCostTarget,
} from "@/lib/pricing/status";
import type { CellarWineRow } from "./types";
import { PricingTargetOverride } from "./pricing-target-override";

/**
 * BND-040 — PricingSection. Renders the pricing panel for wines that
 * have retail price data. Shows glass/bottle prices and their margins
 * relative to the restaurant's pricing targets.
 */
export function PricingSection({
  row,
  canManage,
}: {
  row: CellarWineRow;
  canManage: boolean;
}) {
  const targetMarkup = resolveMarkupTarget(
    row.pricing_target_markup_ratio,
    row.restaurant_default_target_markup_ratio,
  );
  const targetPourCost = resolvePourCostTarget(
    row.pricing_target_pour_cost_pct,
    row.restaurant_default_target_pour_cost_pct,
  );
  const markupRatio = getMarkupRatio(row.current_bottle_price, row.retail_median);
  const pourCostPct = getPourCostPct(
    row.current_unit_cost,
    row.size_ml,
    row.glass_pour_ml,
    row.current_glass_price,
  );
  const glassStatus = getGlassStatus(pourCostPct, targetPourCost);
  const bottleStatus = getBottleStatus(markupRatio, targetMarkup);

  // No list prices → no card. A full-weight card holding only a staleness
  // disclaimer spent prime hierarchy on dead content (Kimi audit).
  const hasAnyPrice =
    (row.current_glass_price != null && row.glass_pour_ml != null) ||
    row.current_bottle_price != null;
  if (!hasAnyPrice) {
    return (
      <p aria-label="Pricing" className="mt-md text-[12px] text-grey">
        Retail reference on file · no list prices set
        {isRetailStale(row.retail_refreshed_at ?? undefined) &&
          " · retail data over 30 days old"}
      </p>
    );
  }

  return (
    <section
      aria-label="Pricing"
      className="mt-md rounded-lg card-surface p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-sm">Pricing</h3>

      <div className="space-y-sm">
        {/* Glass pour row */}
        {row.current_glass_price != null && row.glass_pour_ml && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] font-medium text-ink">
                ${row.current_glass_price.toFixed(2)}{" "}
                <span className="font-normal text-grey">
                  / {(row.glass_pour_ml / ML_PER_OZ).toFixed(1)} oz glass
                </span>
              </p>
              {glassStatus !== "on_target" && glassStatus !== "unknown" && (
                <p className="text-[12px] text-grey">
                  {formatPricingStatusLabel(glassStatus)}
                </p>
              )}
            </div>
            <PriceBand
              bottleList={row.current_bottle_price}
              retailReference={row.retail_median}
              targetMarkup={targetMarkup}
              size="mini"
            />
          </div>
        )}

        {/* Bottle row */}
        {row.current_bottle_price != null && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] font-medium text-ink">
                ${row.current_bottle_price.toFixed(2)}{" "}
                <span className="font-normal text-grey">/ bottle</span>
              </p>
              {bottleStatus !== "on_target" && bottleStatus !== "unknown" && (
                <p className="text-[12px] text-grey">
                  {formatPricingStatusLabel(bottleStatus)}
                </p>
              )}
            </div>
            <PriceBand
              bottleList={row.current_bottle_price}
              retailReference={row.retail_median}
              targetMarkup={targetMarkup}
              size="mini"
            />
          </div>
        )}

        {isRetailStale(row.retail_refreshed_at ?? undefined) && (
          <p className="text-[11px] text-grey">
            Retail data is over 30 days old. May not reflect current pricing.
          </p>
        )}
      </div>

      {canManage && row.current_bottle_price != null && (
        <div className="mt-md">
          <PricingTargetOverride
            wineId={row.wine_id}
            perWinePourCostPct={row.pricing_target_pour_cost_pct}
            perWineMarkupRatio={row.pricing_target_markup_ratio}
            housePourCostPct={
              row.restaurant_default_target_pour_cost_pct ?? targetPourCost
            }
            houseMarkupRatio={
              row.restaurant_default_target_markup_ratio ?? targetMarkup
            }
          />
        </div>
      )}
    </section>
  );
}
