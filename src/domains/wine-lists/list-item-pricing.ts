/**
 * LIST-03 / LIST-04 — a wine-list row always has a price to show.
 *
 * The row used to render "—" whenever `glass_price` / `bottle_price` was null,
 * which is the default state, because the add-wine modal only filled those
 * inputs when the user pressed "Use these". The PRD is explicit that pricing is
 * *always* available and that the app *suggests* the starting point with the
 * settings rule already applied.
 *
 * This computes that suggestion for a whole list in one pass, using exactly the
 * chain `/api/wines/[id]/pricing-suggestion` uses — per-wine override →
 * restaurant default → category band → house constant — so the number on the
 * row is the number the modal would have offered.
 *
 * KNOWN GAP (deliberate, flagged rather than invented): the rule wired here is
 * a markup on `retail_median`, not "N% above what the restaurant paid". A
 * purchase-cost markup setting does not exist in the schema and adding one is a
 * product decision outside this ticket. Invoice cost *is* used for the glass
 * price, which is where the existing code already prefers it.
 */

import { getCategoryMidpointMarkup } from "@/lib/pricing/category-bands";
import {
  isGlassPricePlausible,
  resolveMarkupTarget,
  resolvePourCostTarget,
  suggestBottlePrice,
  suggestGlassPrice,
} from "@/lib/pricing/status";

/** 5 oz — the same default the pricing-suggestion route uses. */
export const DEFAULT_GLASS_POUR_ML = 148;

export type PricingWine = {
  id: string;
  varietal: string | null;
  region: string | null;
  rating: number | null;
  size_ml: number | null;
  retail_median: number | null;
  pricing_target_markup_ratio: number | null;
  pricing_target_pour_cost_pct: number | null;
};

export type RestaurantPricingDefaults = {
  default_target_markup_ratio: number | null;
  default_target_pour_cost_pct: number | null;
};

export type SuggestedPrices = {
  suggestedGlass: number | null;
  suggestedBottle: number | null;
};

/**
 * Suggested glass + bottle price for one wine.
 *
 * @param invoiceCost most recent `inventory_items.unit_cost`, when known; the
 *   glass suggestion falls back to retail median without it, matching the route.
 * @param glassPourMl the row's own pour size when set, else the 148 ml default.
 * @param bottleReference the bottle price already set on the row, when there is
 *   one; the glass suggestion is sanity-checked against it before the computed
 *   bottle suggestion.
 */
export function suggestPricesForWine(
  wine: PricingWine,
  restaurant: RestaurantPricingDefaults | null,
  invoiceCost: number | null,
  glassPourMl: number | null,
  bottleReference: number | null = null,
): SuggestedPrices {
  const categoryMarkup = getCategoryMidpointMarkup(wine);
  const targetMarkup = resolveMarkupTarget(
    wine.pricing_target_markup_ratio,
    restaurant?.default_target_markup_ratio ?? categoryMarkup,
  );
  const targetPourCostPct = resolvePourCostTarget(
    wine.pricing_target_pour_cost_pct,
    restaurant?.default_target_pour_cost_pct,
  );
  const suggestedBottle = suggestBottlePrice(wine.retail_median, targetMarkup);
  const suggestedGlass = suggestGlassPrice(
    invoiceCost ?? wine.retail_median,
    wine.size_ml,
    glassPourMl ?? DEFAULT_GLASS_POUR_ML,
    targetPourCostPct,
  );
  return {
    suggestedBottle,
    // A glass at or above the bottle price is not a suggestion anyone can use,
    // whatever produced it. Prefer the price actually set on the row as the
    // anchor, since that is what the user is looking at next to it.
    suggestedGlass: isGlassPricePlausible(
      suggestedGlass,
      bottleReference ?? suggestedBottle,
    )
      ? suggestedGlass
      : null,
  };
}

/**
 * Latest unit cost per wine, from `inventory_items` rows already ordered
 * newest-first. One pass, so a list of any size costs one query rather than one
 * per row.
 */
export function latestUnitCostByWine(
  rows: Array<{ wine_id: string; unit_cost: number | null }>,
): Map<string, number> {
  const costs = new Map<string, number>();
  for (const row of rows) {
    if (row.unit_cost == null) continue;
    if (!costs.has(row.wine_id)) costs.set(row.wine_id, row.unit_cost);
  }
  return costs;
}
