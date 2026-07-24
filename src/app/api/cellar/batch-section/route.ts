import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { BatchCellarSectionBodySchema } from "@/lib/api/cellar-collection-schemas";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

/**
 * POST /api/cellar/batch-section — bulk-assign wines to a cellar section.
 *
 * Role-gated to owner | manager. Updates all inventory_items for the
 * given wines within the caller's restaurant in a single operation.
 * BND-064 — bulk-assign wines to a section.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(
      request,
      BatchCellarSectionBodySchema,
    );
    if (!parsed.ok) return parsed.response;
    const { wine_ids, section } = parsed.data;

    const { error } = await supabase.rpc(
      "assign_cellar_section_batch",
      {
        p_restaurant_id: restaurantId,
        p_wine_ids: wine_ids,
        p_section: section,
      },
    );
    if (error) {
      if (error.message === "cellar_section_not_configured") {
        return Errors.badRequest(
          "Section is not configured for your restaurant.",
        );
      }
      if (error.message === "cellar_inventory_missing") {
        return Errors.notFound("Inventory item");
      }
      if (
        error.message === "cellar_batch_invalid_size" ||
        error.message === "cellar_batch_duplicate_wine"
      ) {
        return Errors.badRequest("Invalid cellar batch.");
      }
      throw error;
    }

    return NextResponse.json({
      updated: wine_ids.length,
      section,
    });
  });
}
