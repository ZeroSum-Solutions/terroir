import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { PRESERVATION_METHODS } from "@/lib/partial-bottles/math";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
  preservation_method: z.enum(PRESERVATION_METHODS).default("none"),
});

/**
 * POST /api/open-bottles
 *
 * BND-121. Opens a bottle for a wine WITHOUT recording a pour event.
 * Decrements sealed inventory and creates an open_bottles row directly.
 * No pour_events row is created — this is for tasting or prep, not
 * for recording a sale pour.
 *
 * Auth: any member (staff+) can open bottles.
 *
 * 201: { open_bottle: { id, wine_id, remaining_ml, opened_at } }
 * 400: invalid body
 * 401: unauthenticated
 * 403: wine not in caller's restaurant
 * 404: wine not found
 * 409: no_sealed_stock — no sealed inventory to open
 * 500: unhandled failure
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postOpenBottle(request));
}

async function postOpenBottle(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, user } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id, preservation_method } = parsed.data;

  // Verify the wine belongs to this restaurant and get its size
  const { data: wine, error: wineErr } = await supabase
    .from("wines")
    .select("id, restaurant_id, size_ml")
    .eq("id", wine_id)
    .single();

  if (wineErr && (wineErr as { code?: string }).code !== "PGRST116") {
    throw wineErr;
  }
  if (!wine) {
    return Errors.notFound("Wine");
  }

  if (wine.restaurant_id !== restaurantId) {
    return Errors.forbidden("Forbidden.");
  }

  const sizeMl = wine.size_ml ?? 750;

  // Find sealed inventory to decrement
  const { data: sealedItem, error: sealedErr } = await supabase
    .from("inventory_items")
    .select("id, quantity")
    .eq("wine_id", wine_id)
    .eq("restaurant_id", restaurantId)
    .gt("quantity", 0)
    .order("added_at", { ascending: true })
    .limit(1)
    .single();

  if (sealedErr && (sealedErr as { code?: string }).code !== "PGRST116") {
    throw sealedErr;
  }
  if (!sealedItem) {
    return Errors.conflict(
      "no_sealed_stock",
      "No sealed bottles available to open.",
    );
  }

  // Resolve the write path before mutating sealed inventory. Deliberately
  // NOT filtered to closed_at IS NULL (C08, db audit 2026-08-23): a
  // wine+restaurant has at most one open_bottles row ever (UNIQUE
  // wine_id, restaurant_id — 0016), whether active or closed. Filtering
  // out a closed row here made the code below treat it as "none exists"
  // and fall into the plain-INSERT path, which then hit that same unique
  // constraint and errored AFTER sealed inventory had already been
  // decremented (a bottle permanently lost, no open bottle created).
  // Finding any existing row — active or closed — routes to the
  // update-in-place branch instead, reviving a closed row exactly the
  // way record_pour's own upsert already does.
  const { data: existingBottle, error: existingError } = await supabase
    .from("open_bottles")
    .select("id, closed_at")
    .eq("wine_id", wine_id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (existingError) throw existingError;

  const service = createServiceRoleClient();
  if (!service) return Errors.internal("Failed to open bottle.");

  // Decrement sealed inventory
  const { error: decErr } = await service
    .from("inventory_items")
    .update({ quantity: sealedItem.quantity - 1 })
    .eq("id", sealedItem.id)
    .eq("restaurant_id", restaurantId);

  if (decErr) {
    console.error("Failed to decrement inventory while opening bottle.");
    return Errors.internal("Failed to open bottle.");
  }

  if (existingBottle) {
    // A row already exists for this wine (active, or closed and being
    // revived) — update it in place rather than inserting a new one.
    const { data: updated, error: updateErr } = await service
      .from("open_bottles")
      .update({
        remaining_ml: sizeMl,
        opened_at: new Date().toISOString(),
        opened_by: user.id,
        preservation_method,
        closed_at: null,
      })
      .eq("id", existingBottle.id)
      .eq("restaurant_id", restaurantId)
      .select("id, wine_id, remaining_ml, opened_at, opened_by, preservation_method")
      .single();

    if (updateErr || !updated) {
      console.error("Failed to replace open bottle.");
      return Errors.internal("Failed to open bottle.");
    }

    revalidatePath("/cellar/open");
    return NextResponse.json({ open_bottle: updated }, { status: 201 });
  }

  // Create a new open bottle without a pour_events row
  const { data: created, error: insertErr } = await service
    .from("open_bottles")
    .insert({
      wine_id,
      restaurant_id: restaurantId,
      remaining_ml: sizeMl,
      opened_by: user.id,
      preservation_method,
    })
    .select("id, wine_id, remaining_ml, opened_at, opened_by, preservation_method")
    .single();

  if (insertErr || !created) {
    console.error("Failed to create open bottle.");
    return Errors.internal("Failed to open bottle.");
  }

  revalidatePath("/cellar/open");

  return NextResponse.json({ open_bottle: created }, { status: 201 });
}
