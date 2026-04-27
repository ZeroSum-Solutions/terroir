import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import {
  resolveMarkupTarget,
  resolvePourCostTarget,
  suggestBottlePrice,
  suggestGlassPrice,
} from "@/lib/pricing/status";
import { getCategoryMidpointMarkup } from "@/lib/pricing/category-bands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_GLASS_POUR_ML = 148; // 5 oz

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
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "wine id required" }, { status: 400 });
  }

  const url = new URL(req.url);
  const glassPourMlParam = url.searchParams.get("glassPourMl");
  const glassPourMl =
    glassPourMlParam && Number.isFinite(Number(glassPourMlParam))
      ? Math.max(15, Math.min(750, Math.round(Number(glassPourMlParam))))
      : DEFAULT_GLASS_POUR_ML;

  try {
    // Pull wine + its targets + retail cache.
    const { data: wine, error: wineErr } = await supabase
      .from("wines")
      .select(
        "id, varietal, region, rating, retail_median, retail_min, retail_max, retail_retailer_count, retail_refreshed_at, pricing_target_pour_cost_pct, pricing_target_markup_ratio, size_ml",
      )
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .single();
    if (wineErr || !wine) {
      return NextResponse.json({ error: "Wine not found." }, { status: 404 });
    }

    // Pull restaurant defaults.
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select(
        "default_target_pour_cost_pct, default_target_markup_ratio",
      )
      .eq("id", restaurantId)
      .single();

    // Pull most-recent invoice cost.
    const { data: invRow } = await supabase
      .from("inventory_items")
      .select("unit_cost")
      .eq("restaurant_id", restaurantId)
      .eq("wine_id", id)
      .order("added_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const invoiceCost = invRow?.unit_cost ?? null;

    // Resolve targets — per-wine > restaurant > category band > built-in.
    // Markup specifically prefers the category band when no overrides set
    // (more accurate than house default for category-specific wines).
    const categoryMarkup = getCategoryMidpointMarkup(wine);
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
      categoryBandApplied: categoryMarkup != null,
      hasRetailData: wine.retail_median != null,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "wines-pricing-suggestion", phase: "fetch" },
      extra: { wineId: id, restaurantId },
    });
    return NextResponse.json(
      { error: "Failed to compute suggestion." },
      { status: 500 },
    );
  }
}
