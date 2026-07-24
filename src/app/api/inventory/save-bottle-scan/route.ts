import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireMembership } from "@/lib/api/auth";
import {
  isValidIdempotencyKey,
  withIdempotency,
} from "@/lib/api/idempotency";
import { withApiHandler } from "@/lib/api/handler";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import { SaveBottleScanBodySchema } from "@/lib/scanner/request-schemas";
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
  return withApiHandler(() => postBottleInventorySave(request));
}

async function postBottleInventorySave(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, SaveBottleScanBodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const body: SaveBottleBody = parsed.data;

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

  return apiResultResponse(result);
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
    Sentry.captureException(batchError ?? new Error("wineIdArray empty without error"), {
      tags: { surface: "save-bottle-scan", phase: "find_or_create_wines_batch" },
      extra: { restaurantId },
    });
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
    Sentry.captureException(inventoryError, {
      tags: { surface: "save-bottle-scan", phase: "inventory_items-insert" },
      extra: { restaurantId, wineId },
    });
    return {
      status: 500,
      body: { error: "Failed to save inventory item." },
    };
  }

  // LWIN matching — fire-and-forget. INT-017: failures were logged
  // but dropped, so a systemic LWIN outage wouldn't surface in
  // Sentry. Pipe through captureException with a non-route tag so
  // the dashboards can separate "inventory save failed" (500 to
  // user) from "LWIN sidecar degraded" (silent, background).
  supabase
    .rpc("match_lwin_batch", {
      p_restaurant_id: restaurantId,
      p_wine_ids: [wineId],
    })
    .then(({ error: lwinError }) => {
      if (lwinError) {
        console.error("LWIN match failed:", lwinError);
        Sentry.captureException(lwinError, {
          tags: { surface: "lwin-match", phase: "match_lwin_batch-rpc", path: "save-bottle-scan" },
          extra: { wineId },
        });
      }
    });

  return { status: 200, body: { wineId } };
}
