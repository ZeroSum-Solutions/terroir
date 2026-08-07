import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { fetchRetailPrices } from "@/lib/wine-intelligence/wine-searcher";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

export async function POST(
  request: Request,
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

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/wines/{param}/refresh-retail",
      payload: { id },
      releaseOnError: false,
      handler: () => refreshRetailResponse({ supabase, restaurantId, id }),
    });
  });
}

async function refreshRetailResponse({
  supabase,
  restaurantId,
  id,
}: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  id: string;
}) {
    const { data: wine, error: fetchError } = await supabase
      .from("wines")
      .select("id, lwin_id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!wine) return errorResult("not_found", "Wine not found.", 404);

    if (!wine.lwin_id) {
      return {
        status: 200,
        body: {
          wineId: wine.id,
          refreshed: false,
          reason: "no_lwin",
          message:
            "This wine isn't matched to LWIN yet. Run cellar enrichment to attempt a match.",
        },
      };
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
      return {
        status: 200,
        body: {
          wineId: wine.id,
          refreshed: false,
          reason: "unavailable",
          message: "Pricing data unavailable for this wine. Try again later.",
        },
      };
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
    if (!updated) return errorResult("not_found", "Wine not found.", 404);

    return {
      status: 200,
      body: {
        wineId: wine.id,
        refreshed: true,
        retail: {
          min: result.retailMin,
          max: result.retailMax,
          median: result.retailMedian,
          retailerCount: result.retailerCount,
          refreshedAt,
        },
      },
    };
}

function errorResult(code: string, message: string, status: number) {
  return { status, body: { error: { code, message } } };
}
