/**
 * POST /api/scan-bottle/confirm -- creates an inventory_items row for a
 * confirmed bottle with section and bin location (BND-109).
 */
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

const ConfirmSchema = z.object({
  wine_id: z.string().uuid("wine_id must be a valid UUID"),
  section: z.string().min(1, "section is required").max(200),
  bin_location: z.string().min(1, "bin_location is required").max(200),
});

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;

  const { supabase, restaurantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON body.");
  }

  const parsed = ConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return Errors.badRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");
  }

  const { wine_id, section, bin_location } = parsed.data;

  // Verify the wine belongs to this restaurant
  const { data: wine, error: wineErr } = await supabase
    .from("wines")
    .select("id")
    .eq("id", wine_id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (wineErr || !wine) {
    return NextResponse.json(
      { error: "Wine not found or not in your restaurant." },
      { status: 404 },
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
    console.error("inventory_items insert failed:", insertErr);
    return Errors.internal("Failed to record bottle location.");
  }

  return NextResponse.json(item, { status: 201 });
}
