/**
 * POST /api/scan-bottle/confirm -- creates an inventory_items row for a
 * confirmed bottle with section and bin location (BND-109).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { apiError } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { ConfirmBottleBodySchema } from "@/lib/scanner/request-schemas";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withApiHandler(() => postBottleConfirmation(request));
}

async function postBottleConfirmation(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;

  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, ConfirmBottleBodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id, section, bin_location } = parsed.data;

  // Verify the wine belongs to this restaurant
  const { data: wine, error: wineErr } = await supabase
    .from("wines")
    .select("id")
    .eq("id", wine_id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (wineErr && (wineErr as { code?: string }).code !== "PGRST116") {
    throw wineErr;
  }
  if (!wine) {
    return apiError(
      404,
      "wine_not_found",
      "Wine not found or not in your restaurant.",
    );
  }

  // Create the inventory item
  const { data: item, error: insertErr } = await supabase
    .from("inventory_items")
    .insert({
      wine_id,
      restaurant_id: restaurantId,
      section,
      bin_location,
      quantity: 1,
      unit_cost: 0,
      added_via: "manual",
    })
    .select("id, section, bin_location, added_at, wine_id")
    .single();

  if (insertErr || !item) {
    throw insertErr ?? new Error("inventory_items insert returned no row");
  }

  return NextResponse.json(item, { status: 201 });
}
