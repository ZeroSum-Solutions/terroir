import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { fetchRetailPrices } from "@/lib/wine-intelligence/wine-searcher";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage", {
      rateLimit: "expensive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: wine, error: fetchError } = await supabase
      .from("wines")
      .select("id, lwin_id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!wine) return Errors.notFound("Wine");

    if (!wine.lwin_id) {
      return NextResponse.json({
        wineId: wine.id,
        refreshed: false,
        reason: "no_lwin",
        message:
          "This wine isn't matched to LWIN yet. Run cellar enrichment to attempt a match.",
      });
    }

    const { data: inventory, error: inventoryError } = await supabase
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
    if (inventoryError) throw inventoryError;
    const invoiceCost =
      inventory &&
      inventory.unit_cost > 0 &&
      (inventory.currency == null ||
        inventory.currency.toUpperCase() === "USD")
        ? inventory.unit_cost
        : null;

    const result = await fetchRetailPrices({
      lwinId: wine.lwin_id,
      invoiceCost,
    });
    if (!result) {
      return NextResponse.json({
        wineId: wine.id,
        refreshed: false,
        reason: "unavailable",
        message: "Pricing data unavailable for this wine. Try again later.",
      });
    }

    const refreshedAt = result.refreshedAt.toISOString();
    const { data: updated, error } = await supabase
      .from("wines")
      .update({
        retail_min: result.retailMin,
        retail_max: result.retailMax,
        retail_median: result.retailMedian,
        retail_retailer_count: result.retailerCount,
        retail_refreshed_at: refreshedAt,
      })
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) return Errors.notFound("Wine");

    return NextResponse.json({
      wineId: wine.id,
      refreshed: true,
      retail: {
        min: result.retailMin,
        max: result.retailMax,
        median: result.retailMedian,
        retailerCount: result.retailerCount,
        refreshedAt,
      },
    });
  });
}
