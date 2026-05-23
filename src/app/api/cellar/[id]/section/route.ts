import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const SectionSchema = z.object({
  section: z.string().trim().min(1).max(100),
});

/**
 * PATCH /api/cellar/[id]/section — reassign a wine to a different cellar section.
 *
 * Role-gated to owner | manager. Updates all inventory_items for the
 * wine within the caller's restaurant.
 * BND-063 — drag-and-drop wine between sections.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id: wineId } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Verify the wine belongs to this restaurant
  const { data: wine } = await supabase
    .from("wines")
    .select("id")
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!wine) {
    return Errors.notFound("Wine");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = SectionSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }

  const { section } = parsed.data;

  // Update all inventory_items for this wine
  const { error } = await supabase
    .from("inventory_items")
    .update({ section })
    .eq("wine_id", wineId)
    .eq("restaurant_id", restaurantId);

  if (error) {
    console.error("inventory_items section update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "cellar", phase: "update-section" },
      extra: { restaurantId, wineId, section },
    });
    return Errors.internal("Failed to update section.");
  }

  return NextResponse.json({ wine_id: wineId, section });
}
