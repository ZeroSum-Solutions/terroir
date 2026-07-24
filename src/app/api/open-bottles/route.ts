import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
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
  const { wine_id } = parsed.data;

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

  // Resolve the active-bottle write path before mutating sealed inventory.
  const { data: existingBottle, error: existingError } = await supabase
    .from("open_bottles")
    .select("id, closed_at")
    .eq("wine_id", wine_id)
    .eq("restaurant_id", restaurantId)
    .is("closed_at", null)
    .maybeSingle();
  if (existingError) throw existingError;

  // Decrement sealed inventory
  const { error: decErr } = await supabase
    .from("inventory_items")
    .update({ quantity: sealedItem.quantity - 1 })
    .eq("id", sealedItem.id);

  if (decErr) {
    console.error("Failed to decrement inventory:", decErr);
    Sentry.captureException(decErr, {
      tags: { surface: "open-bottles", phase: "decrement" },
      extra: { wine_id, inventory_item_id: sealedItem.id },
    });
    return Errors.internal("Failed to open bottle.");
  }

  if (existingBottle) {
    // There's already an open bottle — just replace it with the new one
    const { data: updated, error: updateErr } = await supabase
      .from("open_bottles")
      .update({
        remaining_ml: sizeMl,
        opened_at: new Date().toISOString(),
        opened_by: user.id,
        closed_at: null,
      })
      .eq("id", existingBottle.id)
      .select("id, wine_id, remaining_ml, opened_at")
      .single();

    if (updateErr || !updated) {
      console.error("Failed to replace open bottle:", updateErr);
      Sentry.captureException(updateErr ?? new Error("No data returned from open_bottles update"), {
        tags: { surface: "open-bottles", phase: "replace" },
        extra: { wine_id },
      });
      return Errors.internal("Failed to open bottle.");
    }

    revalidatePath("/cellar/open");
    return NextResponse.json({ open_bottle: updated }, { status: 201 });
  }

  // Create a new open bottle without a pour_events row
  const { data: created, error: insertErr } = await supabase
    .from("open_bottles")
    .insert({
      wine_id,
      restaurant_id: restaurantId,
      remaining_ml: sizeMl,
      opened_by: user.id,
    })
    .select("id, wine_id, remaining_ml, opened_at")
    .single();

  if (insertErr || !created) {
    console.error("Failed to create open bottle:", insertErr);
    Sentry.captureException(insertErr ?? new Error("No data returned from open_bottles insert"), {
      tags: { surface: "open-bottles", phase: "insert" },
      extra: { wine_id },
    });
    return Errors.internal("Failed to open bottle.");
  }

  revalidatePath("/cellar/open");

  return NextResponse.json({ open_bottle: created }, { status: 201 });
}
