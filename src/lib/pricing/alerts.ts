/**
 * BND-040 — shared pricing alerts pipeline.
 *
 * Single source of truth for the pricing-review alerts list. Used by:
 *   • /api/insights/pricing-review (server-side API for client refetch)
 *   • src/app/(app)/insights/page.tsx (server-component direct call)
 *
 * Mirrors src/lib/drink-window/alerts.ts pattern (BND-039) so both
 * intelligence layers behave consistently. Architect-review finding 7
 * (predicate drift): the snooze filter MUST be in one place — applied
 * here at the SQL layer AND verified by the in-memory deviation filter.
 *
 * Filters:
 *   • is_eightysixed = false (no point alerting on sold-out wines)
 *   • pricing_dismissed_until IS NULL OR < now() (snooze expired)
 *   • retail_median IS NOT NULL (need a benchmark to compare against)
 *   • Wine has at least one wine_list_item with a price set (we can
 *     only judge pricing on wines that ARE on a wine list)
 *   • In-memory: deviation classifies as outlier (per status.ts helpers)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  getBottleStatus,
  getGlassStatus,
  getMarkupRatio,
  getPourCostPct,
  isPricingOutlier,
  isSnoozeActive,
  resolveMarkupTarget,
  resolvePourCostTarget,
} from "./status";

export type PricingAlertRow = {
  wine_id: string;
  wine_list_item_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  bottle_price: number | null;
  glass_price: number | null;
  glass_pour_ml: number | null;
  size_ml: number;
  retail_median: number | null;
  unit_cost: number | null;
  /** Status badges so the UI doesn't recompute them. */
  bottleStatus: ReturnType<typeof getBottleStatus>;
  glassStatus: ReturnType<typeof getGlassStatus>;
  /** Effective targets after per-wine override + restaurant default. */
  targetPourCostPct: number;
  targetMarkupRatio: number;
  /** Computed convenience. */
  pourCostPct: number | null;
  markupRatio: number | null;
};

/**
 * Fetch all pricing-review alerts for a restaurant. Returns array sorted
 * by urgency (largest deviation first).
 *
 * Returns empty on no-alerts (not an error). Throws only on unrecoverable
 * DB errors — callers should catch and 500.
 */
export async function fetchPricingAlerts(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<PricingAlertRow[]> {
  // Get the restaurant defaults first so we know the targets when wines
  // don't have per-wine overrides.
  const { data: restaurant, error: restErr } = await supabase
    .from("restaurants")
    .select("default_target_pour_cost_pct, default_target_markup_ratio")
    .eq("id", restaurantId)
    .single();
  if (restErr) throw restErr;

  const restaurantPourCostTarget = restaurant?.default_target_pour_cost_pct ?? null;
  const restaurantMarkupTarget = restaurant?.default_target_markup_ratio ?? null;

  // Pull wines with pricing-review-eligible state. Snooze filter at SQL
  // layer (architect finding 7).
  const nowIso = new Date().toISOString();
  const { data: wines, error: wineErr } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, varietal, region, retail_median, size_ml, pricing_target_pour_cost_pct, pricing_target_markup_ratio, pricing_dismissed_until",
    )
    .eq("restaurant_id", restaurantId)
    .eq("is_eightysixed", false)
    .not("retail_median", "is", null)
    .or(`pricing_dismissed_until.is.null,pricing_dismissed_until.lt.${nowIso}`);
  if (wineErr) throw wineErr;
  if (!wines || wines.length === 0) return [];

  const wineIds = wines.map((w) => w.id);

  // Pull list items with prices set. Use a simple two-pass join: list
  // items + sections + lists, scoped to this restaurant via restaurant_id
  // on the wine_lists table.
  const { data: listItems, error: itemErr } = await supabase
    .from("wine_list_items")
    .select(
      "id, wine_id, bottle_price, glass_price, glass_pour_ml, section_id, wine_list_sections!inner(wine_list_id, wine_lists!inner(restaurant_id))",
    )
    .in("wine_id", wineIds);
  if (itemErr) throw itemErr;

  // Filter to this restaurant's lists and where at least one price is set.
  type ListItemRow = {
    id: string;
    wine_id: string;
    bottle_price: number | null;
    glass_price: number | null;
    glass_pour_ml: number | null;
    section_id: string;
    wine_list_sections: {
      wine_list_id: string;
      wine_lists: { restaurant_id: string } | { restaurant_id: string }[];
    } | { wine_list_id: string; wine_lists: { restaurant_id: string } | { restaurant_id: string }[] }[];
  };
  const eligibleItems = ((listItems ?? []) as unknown as ListItemRow[]).filter((it) => {
    if (it.bottle_price == null && it.glass_price == null) return false;
    // wine_list_sections may be array or object depending on PostgREST embed depth
    const sections = Array.isArray(it.wine_list_sections)
      ? it.wine_list_sections[0]
      : it.wine_list_sections;
    if (!sections) return false;
    const lists = Array.isArray(sections.wine_lists)
      ? sections.wine_lists[0]
      : sections.wine_lists;
    return lists?.restaurant_id === restaurantId;
  });

  // Pull invoice cost (most-recent inventory_items.unit_cost per wine) so
  // we can compute pour cost % against the actual cost basis. Median
  // retail is fine for markup ratio, but pour cost needs cost-per-bottle.
  const { data: invRows, error: invErr } = await supabase
    .from("inventory_items")
    .select("wine_id, unit_cost, added_at")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wineIds)
    .order("added_at", { ascending: false });
  if (invErr) throw invErr;

  const costByWine = new Map<string, number>();
  for (const row of invRows ?? []) {
    if (!row.wine_id || row.unit_cost == null) continue;
    if (!costByWine.has(row.wine_id)) {
      costByWine.set(row.wine_id, row.unit_cost);
    }
  }

  // Build output. One row per (wine, list_item) — a wine on multiple
  // lists could have different prices on each.
  const wineById = new Map(wines.map((w) => [w.id, w]));
  const alerts: PricingAlertRow[] = [];

  for (const item of eligibleItems) {
    const wine = wineById.get(item.wine_id);
    if (!wine) continue;
    if (isSnoozeActive(wine.pricing_dismissed_until)) continue; // defense-in-depth

    const cost = costByWine.get(wine.id);
    const targetPourCostPct = resolvePourCostTarget(
      wine.pricing_target_pour_cost_pct,
      restaurantPourCostTarget,
    );
    const targetMarkupRatio = resolveMarkupTarget(
      wine.pricing_target_markup_ratio,
      restaurantMarkupTarget,
    );

    const markupRatio = getMarkupRatio(item.bottle_price, wine.retail_median);
    const pourCostPct =
      cost != null
        ? getPourCostPct(cost, wine.size_ml, item.glass_pour_ml, item.glass_price)
        : null;

    const bottleStatus = getBottleStatus(markupRatio, targetMarkupRatio);
    const glassStatus = getGlassStatus(pourCostPct, targetPourCostPct);

    if (!isPricingOutlier(bottleStatus, glassStatus)) continue;

    alerts.push({
      wine_id: wine.id,
      wine_list_item_id: item.id,
      name: wine.name,
      producer: wine.producer,
      vintage: wine.vintage,
      varietal: wine.varietal,
      region: wine.region,
      bottle_price: item.bottle_price,
      glass_price: item.glass_price,
      glass_pour_ml: item.glass_pour_ml,
      size_ml: wine.size_ml,
      retail_median: wine.retail_median,
      unit_cost: cost ?? null,
      bottleStatus,
      glassStatus,
      targetPourCostPct,
      targetMarkupRatio,
      pourCostPct,
      markupRatio,
    });
  }

  // Sort: outlier-on-both first, then by combined deviation magnitude
  // (largest first), then alphabetically by producer for stable order.
  // Reviewer-find Minor 10 — comment + code now agree.
  const deviationMagnitude = (a: PricingAlertRow): number => {
    let total = 0;
    if (a.markupRatio != null && a.targetMarkupRatio > 0) {
      total += Math.abs((a.markupRatio - a.targetMarkupRatio) / a.targetMarkupRatio);
    }
    if (a.pourCostPct != null && a.targetPourCostPct > 0) {
      total += Math.abs(
        (a.pourCostPct - a.targetPourCostPct) / a.targetPourCostPct,
      );
    }
    return total;
  };
  alerts.sort((a, b) => {
    const aBoth = a.bottleStatus === "outlier" && a.glassStatus === "outlier";
    const bBoth = b.bottleStatus === "outlier" && b.glassStatus === "outlier";
    if (aBoth !== bBoth) return aBoth ? -1 : 1;
    const aMag = deviationMagnitude(a);
    const bMag = deviationMagnitude(b);
    if (aMag !== bMag) return bMag - aMag; // largest first
    return a.producer.localeCompare(b.producer);
  });

  return alerts;
}
