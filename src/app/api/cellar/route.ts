import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { Errors } from "@/lib/api/errors";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";

export const runtime = "nodejs";

const AddWineSchema = z.object({
  name: z.string().trim().min(1).max(200),
  producer: z.string().trim().min(1).max(200),
  vintage: z.number().int().min(1900).max(2100).nullable().optional(),
  varietal: z.string().trim().max(100).nullable().optional(),
  region: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
  quantity: z.number().int().min(1).default(1),
  unit_cost: z.number().min(0).optional(),
});

/**
 * POST /api/cellar — add a wine to the cellar inventory.
 *
 * Role-gated to any authenticated member (owner, manager, staff).
 * Creates the wine via find_or_create_wines_batch, inserts an
 * inventory_items row with added_via = "manual".
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

  const parsed = AddWineSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }

  const { name, producer, vintage, varietal, region, country, quantity, unit_cost } =
    parsed.data;

  // Create the wine via the DB function
  const { data: wineIdArray, error: batchError } = await supabase.rpc(
    "find_or_create_wines_batch",
    {
      p_restaurant_id: restaurantId,
      p_wines: [
        {
          name,
          producer,
          vintage: vintage ?? null,
          varietal: varietal ?? null,
          region: region ?? null,
          country: country ?? null,
          size_ml: 750,
        },
      ],
    },
  );

  if (batchError || !wineIdArray?.[0]) {
    console.error("find_or_create_wines_batch failed:", batchError);
    Sentry.captureException(
      batchError ?? new Error("find_or_create_wines_batch returned empty"),
      {
        tags: { surface: "cellar", phase: "add-wine-batch" },
        extra: { restaurantId, name, producer },
      },
    );
    return Errors.internal("Failed to create wine.");
  }

  const wineId = (wineIdArray as string[])[0];

  // Create inventory item
  const { data: inventoryItem, error: inventoryError } = await supabase
    .from("inventory_items")
    .insert({
      wine_id: wineId,
      restaurant_id: restaurantId,
      quantity,
      unit_cost: unit_cost ?? 0,
      added_via: "manual" as const,
    })
    .select("id, quantity, unit_cost")
    .single();

  if (inventoryError || !inventoryItem) {
    console.error("inventory_items insert failed:", inventoryError);
    Sentry.captureException(
      inventoryError ?? new Error("inventoryItem null without error"),
      {
        tags: { surface: "cellar", phase: "add-wine-inventory" },
        extra: { restaurantId, wineId },
      },
    );
    return Errors.internal("Failed to add wine to inventory.");
  }

  return NextResponse.json({
    wineId,
    inventoryId: inventoryItem.id,
    quantity: inventoryItem.quantity,
    unitCost: inventoryItem.unit_cost,
  });
}
