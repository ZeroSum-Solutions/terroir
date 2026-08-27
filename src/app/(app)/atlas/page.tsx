import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import type { CellarFacetRow } from "@/lib/cellar-facets";
import { AtlasShell } from "./atlas-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Atlas" };

/**
 * Atlas v1 (recon lane "atlas-map") — a geographic map of the user's own
 * cellar. Mirrors cellar/page.tsx's auth + restaurant-scoped fetch
 * pattern, but only pulls the fields src/lib/cellar-facets actually
 * groups by: producer/region/country/varietal/vintage/format + sealed
 * count. No health, pricing, or list-price joins — those don't affect
 * the map.
 */
export default async function AtlasPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId, restaurantName } = auth;

  const [
    { data: wineRows, error: wineError },
    { data: inventoryRows, error: inventoryError },
  ] = await Promise.all([
    supabase
      .from("wines")
      .select("id, producer, region, country, varietal, vintage, size_ml")
      .eq("restaurant_id", restaurantId),
    supabase
      .from("inventory_items")
      .select("wine_id, quantity")
      .eq("restaurant_id", restaurantId),
  ]);

  if (wineError || inventoryError) throw wineError ?? inventoryError;

  const sealedByWine = new Map<string, number>();
  for (const item of inventoryRows ?? []) {
    if (!item.wine_id) continue;
    sealedByWine.set(
      item.wine_id,
      (sealedByWine.get(item.wine_id) ?? 0) + (item.quantity ?? 0),
    );
  }

  const rows: CellarFacetRow[] = (wineRows ?? []).map((w) => ({
    wine_id: w.id,
    producer: w.producer,
    region: w.region,
    country: w.country,
    varietal: w.varietal,
    vintage: w.vintage,
    wine_size_ml: w.size_ml,
    sealed_count: sealedByWine.get(w.id) ?? 0,
    healthSegment: null, // not fetched here — the map never facets on health
  }));

  return <AtlasShell rows={rows} restaurantName={restaurantName} />;
}
