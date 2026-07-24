import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams, parseQuery } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { PricingSuggestionQuerySchema } from "@/lib/api/wine-read-query-schemas";
import {
  resolveMarkupTarget,
  resolvePourCostTarget,
  suggestBottlePrice,
  suggestGlassPrice,
} from "@/lib/pricing/status";
import { getCategoryMidpointMarkup } from "@/lib/pricing/category-bands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-040 — GET /api/wines/[id]/pricing-suggestion?glassPourMl=148
 *
 * Returns suggested bottle + glass prices for a wine, derived from:
 *   1. retail_median (Wine-Searcher cache) × target markup
 *   2. invoice cost (most-recent inventory_items.unit_cost) ÷ target pour cost %
 *
 * Targets resolve in priority: per-wine override → restaurant default →
 * category band midpoint → built-in defaults.
 *
 * Used by AddWineModal's "Suggest prices" button. Returns null prices
 * when retail_median is unavailable — UI shows "Pricing data
 * unavailable" and the user fills in manually.
 *
 * Auth: any restaurant member can read (this endpoint doesn't burn
 * Wine-Searcher quota — it reads cached data only).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(ctx.params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedQuery = await parseQuery(
      new URL(req.url).searchParams,
      PricingSuggestionQuerySchema,
    );
    if (!parsedQuery.ok) return parsedQuery.response;
    const { id } = parsedParams.data;
    const { glassPourMl } = parsedQuery.data;

    // Pull wine + its targets + retail cache.
    const { data: wine, error: wineErr } = await supabase
      .from("wines")
      .select(
        "id, varietal, region, rating, retail_median, retail_min, retail_max, retail_retailer_count, retail_refreshed_at, pricing_target_pour_cost_pct, pricing_target_markup_ratio, size_ml",
      )
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (wineErr) throw wineErr;
    if (!wine) return Errors.notFound("Wine");

    // Pull restaurant defaults.
    const { data: restaurant, error: restaurantError } = await supabase
      .from("restaurants")
      .select(
        "default_target_pour_cost_pct, default_target_markup_ratio",
      )
      .eq("id", restaurantId)
      .maybeSingle();
    if (restaurantError) throw restaurantError;

    // Pull most-recent invoice cost.
    const { data: invRow, error: invoiceError } = await supabase
      .from("inventory_items")
      .select("unit_cost, currency, added_via")
      .eq("restaurant_id", restaurantId)
      .eq("wine_id", id)
      .eq("added_via", "invoice_scan")
      .gt("unit_cost", 0)
      .or("currency.is.null,currency.eq.USD")
      .order("added_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (invoiceError) throw invoiceError;
    const invoiceCost =
      invRow &&
      invRow.unit_cost > 0 &&
      (invRow.currency == null || invRow.currency.toUpperCase() === "USD")
        ? invRow.unit_cost
        : null;

    // Resolve targets — per-wine > restaurant > category band > built-in.
    // Markup specifically prefers the category band when no overrides set
    // (more accurate than house default for category-specific wines).
    const categoryMarkup = getCategoryMidpointMarkup(wine);
    const categoryBandApplied =
      wine.pricing_target_markup_ratio == null &&
      restaurant?.default_target_markup_ratio == null &&
      categoryMarkup != null;
    const targetMarkup = resolveMarkupTarget(
      wine.pricing_target_markup_ratio,
      restaurant?.default_target_markup_ratio ?? categoryMarkup,
    );
    const targetPourCostPct = resolvePourCostTarget(
      wine.pricing_target_pour_cost_pct,
      restaurant?.default_target_pour_cost_pct,
    );

    // Suggested bottle price uses retail × markup.
    const suggestedBottle = suggestBottlePrice(wine.retail_median, targetMarkup);
    // Suggested glass price uses invoice cost ÷ target pour cost. Falls back
    // to retail median when invoice cost unknown.
    const costPerBottle = invoiceCost ?? wine.retail_median;
    const suggestedGlass = suggestGlassPrice(
      costPerBottle,
      wine.size_ml,
      glassPourMl,
      targetPourCostPct,
    );

    return NextResponse.json({
      wineId: wine.id,
      suggestedBottle,
      suggestedGlass,
      glassPourMl,
      targetMarkupRatio: targetMarkup,
      targetPourCostPct,
      retailMedian: wine.retail_median,
      retailMin: wine.retail_min,
      retailMax: wine.retail_max,
      retailRetailerCount: wine.retail_retailer_count,
      retailRefreshedAt: wine.retail_refreshed_at,
      categoryBandApplied,
      hasRetailData: wine.retail_median != null,
    });
  });
}
