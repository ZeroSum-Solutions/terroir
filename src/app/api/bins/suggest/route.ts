import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { suggestPutAway } from "@/lib/bins";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseQuery } from "@/lib/api/validation";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

const QuerySchema = z.strictObject({ wine_id: z.string().uuid() });

function reportFailure(
  phase: "wine" | "bin" | "inventory",
  restaurantId: string,
  wineId: string,
) {
  const message = `bin suggestion ${phase} failed`;
  console.error(message);
  Sentry.captureException(new Error(message), {
    tags: { surface: "bins", phase: `suggest-${phase}` },
    extra: { restaurantId, wineId },
  });
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function fetchWine(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  wineId: string,
) {
  return supabase
    .from("wines")
    .select("id, lineage_id, colour")
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
}

function fetchBins(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
) {
  return supabase
    .from("bins")
    .select("id, code, zone, capacity, retired_at")
    .eq("restaurant_id", restaurantId)
    .is("retired_at", null)
    .order("priority", { ascending: false })
    .order("sort_order")
    .order("code");
}

function fetchInventory(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  binIds: string[],
) {
  return supabase
    .from("inventory_items")
    .select(
      "wine_id, bin_id, quantity, bins(code, zone), wines(lineage_id, name, producer, colour)",
    )
    .eq("restaurant_id", restaurantId)
    .in("bin_id", binIds);
}

type InventoryData = NonNullable<
  Awaited<ReturnType<typeof fetchInventory>>["data"]
>;
type WineData = NonNullable<Awaited<ReturnType<typeof fetchWine>>["data"]>;
type BinData = NonNullable<Awaited<ReturnType<typeof fetchBins>>["data"]>;

function mapInventory(rows: InventoryData) {
  return rows.flatMap((row) => {
    const wine = one(row.wines);
    const bin = one(row.bins);
    if (!wine || !bin) return [];
    return [{
      wineId: row.wine_id,
      lineageId: wine.lineage_id,
      name: wine.name,
      producer: wine.producer,
      colour: wine.colour,
      binId: row.bin_id,
      binCode: bin.code,
      binZone: bin.zone,
      quantity: row.quantity,
    }];
  });
}

function makeSuggestion(
  wine: WineData,
  bins: BinData,
  inventory: InventoryData,
) {
  return suggestPutAway({
    wine: { lineageId: wine.lineage_id, colour: wine.colour },
    bins: bins.map((bin) => ({
      id: bin.id,
      code: bin.code,
      zone: bin.zone,
      capacity: bin.capacity,
      retiredAt: bin.retired_at,
    })),
    inventoryRows: mapInventory(inventory),
  });
}

function suggestionResponse(suggestion: ReturnType<typeof suggestPutAway>) {
  if (!suggestion) return NextResponse.json(null);
  return NextResponse.json({
    bin_id: suggestion.binId,
    code: suggestion.code,
    zone: suggestion.zone,
    reason: suggestion.reason,
  });
}

export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseQuery(request.nextUrl.searchParams, QuerySchema);
    if (!parsed.ok) return parsed.response;
    const wineId = parsed.data.wine_id;

    const { data: wine, error: wineError } = await fetchWine(
      supabase,
      restaurantId,
      wineId,
    );
    if (wineError) {
      reportFailure("wine", restaurantId, wineId);
      return Errors.internal("Failed to fetch wine.");
    }
    if (!wine) return Errors.notFound("Wine");

    const { data: bins, error: binsError } = await fetchBins(
      supabase,
      restaurantId,
    );
    if (binsError) {
      reportFailure("bin", restaurantId, wineId);
      return Errors.internal("Failed to fetch bins.");
    }

    const activeBins = bins ?? [];
    const { data: inventory, error: inventoryError } = activeBins.length
      ? await fetchInventory(
          supabase,
          restaurantId,
          activeBins.map((bin) => bin.id),
        )
      : { data: [], error: null };
    if (inventoryError) {
      reportFailure("inventory", restaurantId, wineId);
      return Errors.internal("Failed to fetch bin inventory.");
    }

    return suggestionResponse(
      makeSuggestion(wine, activeBins, inventory ?? []),
    );
  });
}
