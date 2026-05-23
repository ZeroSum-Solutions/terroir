import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

const BatchSectionSchema = z.object({
  wine_ids: z.array(z.string().uuid()).min(1).max(200),
  section: z.string().trim().min(1).max(100),
});

/**
 * POST /api/cellar/batch-section — bulk-assign wines to a cellar section.
 *
 * Role-gated to owner | manager. Updates all inventory_items for the
 * given wines within the caller's restaurant in a single operation.
 * BND-064 — bulk-assign wines to a section.
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = BatchSectionSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }

  const { wine_ids, section } = parsed.data;

  // Verify all wines belong to this restaurant
  const { data: wines, error: wineErr } = await supabase
    .from("wines")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .in("id", wine_ids);

  if (wineErr) {
    console.error("wines batch verify failed:", wineErr);
    return Errors.internal("Failed to verify wines.");
  }

  if (!wines || wines.length !== wine_ids.length) {
    return Errors.badRequest("One or more wines not found in your restaurant.");
  }

  // Batch update all inventory_items for these wines
  const { error } = await supabase
    .from("inventory_items")
    .update({ section })
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wine_ids);

  if (error) {
    console.error("inventory_items batch section update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "cellar", phase: "batch-section" },
      extra: { restaurantId, count: wine_ids.length, section },
    });
    return Errors.internal("Failed to update sections.");
  }

  return NextResponse.json({
    updated: wine_ids.length,
    section,
  });
}
