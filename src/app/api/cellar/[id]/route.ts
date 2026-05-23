import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

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
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = EditInventorySchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }

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

  if (error) {
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
}
