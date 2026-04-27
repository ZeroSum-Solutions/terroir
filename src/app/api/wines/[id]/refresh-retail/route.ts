import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { fetchRetailPrices } from "@/lib/wine-intelligence/wine-searcher";

export const runtime = "nodejs";

/**
 * BND-040 — POST /api/wines/[id]/refresh-retail
 *
 * Single-wine retail-cache refresh. Calls Wine-Searcher (LWIN-keyed) and
 * writes the result to wines.retail_* columns. Returns the refreshed
 * row state.
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
    return NextResponse.json(
      { error: "Refreshing retail data requires owner or manager role." },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "wine id required" }, { status: 400 });
  }

  // Pull wine row (LWIN + invoice cost for sanity-check).
  const { data: wine, error: fetchErr } = await supabase
    .from("wines")
    .select("id, lwin_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchErr || !wine) {
    return NextResponse.json({ error: "Wine not found." }, { status: 404 });
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
    return NextResponse.json({ error: "Failed to write retail data." }, { status: 500 });
  }

  return NextResponse.json({
    wineId: wine.id,
    refreshed: true,
    retail: {
      min: result.retailMin,
      max: result.retailMax,
      median: result.retailMedian,
      retailerCount: result.retailerCount,
      refreshedAt: result.refreshedAt.toISOString(),
    },
  });
}
