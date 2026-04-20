import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireMembership } from "@/lib/api/auth";
import {
  isValidIdempotencyKey,
  withIdempotency,
} from "@/lib/api/idempotency";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

type SaveBottleBody = {
  wine: {
    name: string;
    producer: string;
    vintage: number | null;
    varietal: string;
    region: string;
    country: string | null;
    qty: number;
    unitCost: number;
  };
};

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: SaveBottleBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { wine } = body;
  if (!wine?.name?.trim() || !wine?.producer?.trim()) {
    return NextResponse.json(
      { error: "Wine name and producer are required." },
      { status: 400 },
    );
  }
  if (
    typeof wine.qty !== "number" ||
    !Number.isFinite(wine.qty) ||
    wine.qty < 1
  ) {
    return NextResponse.json(
      { error: "Quantity must be a positive integer." },
      { status: 400 },
    );
  }
  if (
    typeof wine.unitCost !== "number" ||
    !Number.isFinite(wine.unitCost) ||
    wine.unitCost < 0
  ) {
    return NextResponse.json(
      { error: "Unit cost must be zero or greater." },
      { status: 400 },
    );
  }

  // ── Idempotency (BND-006) ────────────────────────────────────────
  const rawKey = request.headers.get("Idempotency-Key");
  const key = isValidIdempotencyKey(rawKey) ? rawKey : null;

  const result = await withIdempotency({
    supabase,
    restaurantId,
    key,
    handler: async () =>
      saveBottleOnce({ supabase, restaurantId, wine: body.wine }),
  });

  return NextResponse.json(result.body, { status: result.status });
}

async function saveBottleOnce(opts: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wine: SaveBottleBody["wine"];
}): Promise<{ status: number; body: unknown }> {
  const { supabase, restaurantId, wine } = opts;

  // Create or find the wine using the existing batch RPC (single-element array)
  const { data: wineIdArray, error: batchError } = await supabase.rpc(
    "find_or_create_wines_batch",
    {
      p_restaurant_id: restaurantId,
      p_wines: [
        {
          name: wine.name,
          producer: wine.producer,
          vintage: wine.vintage ?? null,
          varietal: wine.varietal || null,
          region: wine.region || null,
          country: wine.country ?? null,
          size_ml: 750,
        },
      ],
    },
  );

  if (batchError || !wineIdArray || (wineIdArray as string[]).length === 0) {
    console.error("find_or_create_wines_batch failed:", batchError);
    return { status: 500, body: { error: "Failed to save wine." } };
  }

  const wineId = (wineIdArray as string[])[0];

  // Insert inventory item
  const { error: inventoryError } = await supabase
    .from("inventory_items")
    .insert({
      wine_id: wineId,
      restaurant_id: restaurantId,
      invoice_scan_id: null,
      quantity: wine.qty,
      unit_cost: wine.unitCost,
      added_via: "bottle_scan" as const,
    });

  if (inventoryError) {
    console.error("inventory_items insert failed:", inventoryError);
    return {
      status: 500,
      body: { error: "Failed to save inventory item." },
    };
  }

  // LWIN matching — fire-and-forget
  supabase
    .rpc("match_lwin_batch", { p_wine_ids: [wineId] })
    .then(({ error: lwinError }) => {
      if (lwinError) console.error("LWIN match failed:", lwinError);
    });

  return { status: 200, body: { wineId } };
}
