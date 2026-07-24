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

const EditInventorySchema = z.object({
  quantity: z.number().int().min(0).optional(),
  unit_cost: z.number().min(0).optional(),
  bin_location: z.string().trim().max(50).nullable().optional(),
});

/**
 * PATCH /api/cellar/[id] — edit an inventory item.
 *
 * Role-gated to owner | manager. Staff receives 403.
 * Scoped by restaurant_id (defense-in-depth).
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
    const { id } = parsedParams.data;

    const parsed = await parseJson(request, EditInventorySchema);
    if (!parsed.ok) return parsed.response;
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return Errors.badRequest("No valid fields to update.");
    }

    // Defense-in-depth: scope by restaurant_id so a cross-tenant
    // inventory item id returns 404 instead of mutating another
    // restaurant's inventory.
    const { data, error } = await supabase
      .from("inventory_items")
      .update(updates)
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id, quantity, unit_cost, bin_location")
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("inventory_items update failed:", error);
      Sentry.captureException(error, {
        tags: { surface: "cellar", phase: "edit-inventory" },
        extra: { restaurantId, inventory_item_id: id },
      });
      return Errors.internal("Update failed.");
    }

    if (!data) {
      return Errors.notFound("Inventory item");
    }

    return NextResponse.json(data);
  });
}

/**
 * DELETE /api/cellar/[id] — delete a wine from the cellar.
 *
 * Owner-only. Checks referential integrity before deleting:
 * the wine must have no pour_events, inventory_items, wine_list_items,
 * or invoice_scans referencing it. If any exist, returns 409 with
 * a descriptive message listing which references block deletion.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id: wineId } = parsedParams.data;

    // Verify the wine belongs to this restaurant
    const { data: wine, error: wineError } = await supabase
      .from("wines")
      .select("id, name, producer, vintage")
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId)
      .single();

    if (wineError && wineError.code !== "PGRST116") {
      console.error("wines lookup failed:", wineError);
      Sentry.captureException(wineError, {
        tags: { surface: "cellar", phase: "find-wine-for-delete" },
        extra: { restaurantId, wineId },
      });
      return Errors.internal("Failed to find wine.");
    }

    if (!wine) {
      return Errors.notFound("Wine");
    }

    // Check referential integrity — pour_events FK is ON DELETE RESTRICT
    const { count: pourCount, error: pourErr } = await supabase
      .from("pour_events")
      .select("*", { count: "exact", head: true })
      .eq("wine_id", wineId);

    if (pourErr) {
      console.error("pour_events check failed:", pourErr);
      return Errors.internal("Failed to check pour history.");
    }
    if (pourCount != null && pourCount > 0) {
      return Errors.conflict(
        "wine_has_pours",
        `Cannot delete "${wine.producer} ${wine.name}" — it has ${pourCount} pour event${pourCount === 1 ? "" : "s"}.`,
      );
    }

    // Check inventory_items — FK is ON DELETE RESTRICT
    const { count: invCount, error: invErr } = await supabase
      .from("inventory_items")
      .select("*", { count: "exact", head: true })
      .eq("wine_id", wineId);

    if (invErr) {
      console.error("inventory_items check failed:", invErr);
      return Errors.internal("Failed to check inventory.");
    }
    if (invCount != null && invCount > 0) {
      return Errors.conflict(
        "wine_has_inventory",
        `Cannot delete "${wine.producer} ${wine.name}" — it has ${invCount} inventory item${invCount === 1 ? "" : "s"}. 86 the wine instead.`,
      );
    }

    // Check wine_list_items — FK is ON DELETE RESTRICT
    const { count: wliCount, error: wliErr } = await supabase
      .from("wine_list_items")
      .select("*", { count: "exact", head: true })
      .eq("wine_id", wineId);

    if (wliErr) {
      console.error("wine_list_items check failed:", wliErr);
      return Errors.internal("Failed to check wine list references.");
    }
    if (wliCount != null && wliCount > 0) {
      return Errors.conflict(
        "wine_on_lists",
        `Cannot delete "${wine.producer} ${wine.name}" — it appears on ${wliCount} wine list${wliCount === 1 ? "" : "s"}. Remove it from lists first.`,
      );
    }

    // Check invoice_scans for scan line items referencing this wine.
    const { data: scanRefs, error: scanErr } = await supabase
      .from("invoice_scans")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .contains("parsed_line_items", JSON.stringify([{ name: wine.name }]));

    if (scanErr) {
      console.error("invoice_scans check failed:", scanErr);
      return Errors.internal("Failed to check scan references.");
    }
    if (scanRefs && scanRefs.length > 0) {
      return Errors.conflict(
        "wine_from_scan",
        `Cannot delete "${wine.producer} ${wine.name}" — it was imported via ${scanRefs.length} invoice scan${scanRefs.length === 1 ? "" : "s"}. Remove the scan record first.`,
      );
    }

    // All checks passed — delete the wine. CASCADE deletes open_bottles
    // and availability_events automatically.
    const { error: deleteErr } = await supabase
      .from("wines")
      .delete()
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId);

    if (deleteErr) {
      console.error("wines delete failed:", deleteErr);
      Sentry.captureException(deleteErr, {
        tags: { surface: "cellar", phase: "delete-wine" },
        extra: { restaurantId, wineId },
      });
      return Errors.internal("Failed to delete wine.");
    }

    return NextResponse.json({ deleted: true });
  });
}
