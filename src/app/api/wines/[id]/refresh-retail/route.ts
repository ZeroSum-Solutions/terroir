import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import {
  fetchRetailPrices,
  formatRetailPriceBasis,
} from "@/lib/wine-intelligence/wine-searcher";

export const runtime = "nodejs";

/**
 * BND-040 — POST /api/wines/[id]/refresh-retail
 *
 * Single-wine retail-cache refresh. Calls Wine-Searcher (LWIN-keyed),
 * writes true-median results to wines.retail_* columns, and returns
 * average-only results with an explicit non-persisted label.
 *
 * Auth: owner+manager only — pricing intelligence burns Wine-Searcher
 * trial-tier quota fast under staff misuse (architect finding 8).
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    return Errors.forbidden("Refreshing retail data requires owner or manager role.");
  }

  const { id } = await ctx.params;
  if (!id) {
    return Errors.badRequest("wine id required");
  }

  // Pull wine row (LWIN + invoice cost for sanity-check).
  const { data: wine, error: fetchErr } = await supabase
    .from("wines")
    .select("id, lwin_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchErr || !wine) {
    return Errors.notFound("Wine");
  }

  if (!wine.lwin_id) {
    return NextResponse.json(
      {
        wineId: wine.id,
        refreshed: false,
        reason: "no_lwin",
        message: "This wine isn't matched to LWIN yet. Run cellar enrichment to attempt a match.",
      },
      { status: 200 },
    );
  }

  // Pull most-recent invoice cost for the sanity-filter.
  const { data: invRow } = await supabase
    .from("inventory_items")
    .select("unit_cost")
    .eq("restaurant_id", restaurantId)
    .eq("wine_id", id)
    .order("added_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const invoiceCost = invRow?.unit_cost ?? null;

  const result = await fetchRetailPrices({
    lwinId: wine.lwin_id,
    invoiceCost,
  });

  if (!result) {
    // Could be: no API key, network error, sanity-filter rejection,
    // schema failure. wine-searcher.ts has already logged to Sentry
    // with the specific reason.
    return NextResponse.json(
      {
        wineId: wine.id,
        refreshed: false,
        reason: "unavailable",
        message: "Pricing data unavailable for this wine. Try again later.",
      },
      { status: 200 },
    );
  }

  if (result.retailMedianBasis === "average") {
    // The frozen schema has no basis column, so never persist an average in
    // retail_median. Return the value under an honest, non-persisted label.
    return NextResponse.json({
      wineId: wine.id,
      refreshed: false,
      reason: "average_only",
      message: "Only an avg-based retail price was available; it was not saved as a median.",
      retail: {
        min: result.retailMin,
        max: result.retailMax,
        referencePrice: result.retailMedian,
        referencePriceBasis: result.retailMedianBasis,
        referencePriceLabel: formatRetailPriceBasis(result.retailMedianBasis),
        retailerCount: result.retailerCount,
        refreshedAt: result.refreshedAt.toISOString(),
      },
    });
  }

  const { error: writeErr } = await supabase
    .from("wines")
    .update({
      retail_min: result.retailMin,
      retail_max: result.retailMax,
      retail_median: result.retailMedian,
      retail_retailer_count: result.retailerCount,
      retail_refreshed_at: result.refreshedAt.toISOString(),
    })
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (writeErr) {
    Sentry.captureException(writeErr, {
      tags: { surface: "wines-refresh-retail", phase: "db-write" },
      extra: { wineId: id, restaurantId },
    });
    return Errors.internal("Failed to write retail data.");
  }

  return NextResponse.json({
    wineId: wine.id,
    refreshed: true,
    retail: {
      min: result.retailMin,
      max: result.retailMax,
      median: result.retailMedian,
      medianBasis: result.retailMedianBasis,
      medianLabel: formatRetailPriceBasis(result.retailMedianBasis),
      retailerCount: result.retailerCount,
      refreshedAt: result.refreshedAt.toISOString(),
    },
  });
}
