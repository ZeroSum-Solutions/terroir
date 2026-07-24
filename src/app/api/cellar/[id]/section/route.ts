import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const ParamsSchema = z.strictObject({ id: z.string().uuid() });

const SectionSchema = z.object({
  section: z.string().trim().min(1).max(100).nullable(),
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
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id: wineId } = parsedParams.data;

    const parsed = await parseJson(request, SectionSchema);
    if (!parsed.ok) return parsed.response;
    const { section } = parsed.data;

    // Verify the wine belongs to this restaurant
    const { data: wine, error: wineError } = await supabase
      .from("wines")
      .select("id")
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId)
      .single();

    if (wineError && wineError.code !== "PGRST116") {
      console.error("wines lookup failed:", wineError);
      Sentry.captureException(wineError, {
        tags: { surface: "cellar", phase: "find-wine-for-section" },
        extra: { restaurantId, wineId, section },
      });
      return Errors.internal("Failed to find wine.");
    }

    if (!wine) {
      return Errors.notFound("Wine");
    }

    // Update all inventory_items for this wine
    const { data: updatedRows, error } = await supabase
      .from("inventory_items")
      .update({ section })
      .eq("wine_id", wineId)
      .eq("restaurant_id", restaurantId)
      .select("id");

    if (error) {
      console.error("inventory_items section update failed:", error);
      Sentry.captureException(error, {
        tags: { surface: "cellar", phase: "update-section" },
        extra: { restaurantId, wineId, section },
      });
      return Errors.internal("Failed to update section.");
    }

    if (!updatedRows?.length) {
      return Errors.notFound("Inventory");
    }

    return NextResponse.json({ wine_id: wineId, section });
  });
}
