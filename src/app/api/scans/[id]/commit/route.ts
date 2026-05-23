import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthContext } from "@/lib/auth-context";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, restaurantId } = auth;

  const { data: scan, error: fetchErr } = await supabase
    .from("invoice_scans")
    .select("id, final_line_items, restaurant_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchErr || !scan) {
    return NextResponse.json({ error: "Scan not found." }, { status: 404 });
  }

  const items = (scan.final_line_items ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "No line items to commit." }, { status: 400 });
  }

  const winesPayload = items.map(function(it) {
    return {
      name: (it.name as string) || "",
      producer: (it.producer as string) || "",
      vintage: (it.vintage as number) ?? null,
      varietal: (it.varietal as string) || null,
      region: (it.region as string) || null,
      country: null,
      size_ml: 750,
    };
  });

  const { data: wineIdArray, error: batchError } = await supabase.rpc(
    "find_or_create_wines_batch",
    { p_restaurant_id: restaurantId, p_wines: winesPayload },
  );

  if (batchError || !wineIdArray) {
    console.error("find_or_create_wines_batch failed:", batchError);
    return Errors.internal("Failed to create wines.");
  }

  const wineIds = wineIdArray as string[];

  const inventoryInserts = items.map(function(it, idx) {
    return {
      wine_id: wineIds[idx],
      restaurant_id: restaurantId,
      invoice_scan_id: id,
      quantity: (it.qty as number) || 1,
      unit_cost: (it.unitCost as number) || 0,
      format: (it.format as string) || null,
      currency: (it.currency as string) || null,
      added_via: "invoice_scan" as const,
    };
  });

  const { error: inventoryError } = await supabase
    .from("inventory_items")
    .insert(inventoryInserts);

  if (inventoryError) {
    console.error("inventory_items insert failed:", inventoryError);
    Sentry.captureException(inventoryError, {
      tags: { surface: "scan-commit", phase: "inventory_items-insert" },
      extra: { restaurantId, scanId: id, rowCount: inventoryInserts.length },
    });
    return Errors.internal("Failed to create inventory items.");
  }

  supabase.rpc("match_lwin_batch", { p_wine_ids: wineIds }).then(
    function(r) { if (r.error) console.error("LWIN match failed:", r.error); }
  );

  return NextResponse.json({
    scanId: id,
    itemCount: items.length,
    wineCount: new Set(wineIds).size,
  });
}
