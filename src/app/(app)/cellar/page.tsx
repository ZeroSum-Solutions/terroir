import { getAuthContext } from "@/lib/auth-context";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { CellarShell } from "./cellar-shell";
import type { CellarWineRow } from "./types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BinData = {
  wines: Array<{
    wineId: string;
    name: string;
    producer: string;
    vintage: number | null;
    quantity: number;
  }>;
  totalBottles: number;
};

type GridData = Record<string, BinData>;

/**
 * Cellar single-screen surface (Phase 2 IA redesign — see
 * `.council/specs/2026-04-24-ux-ia-redesign.md` §4).
 *
 * Absorbs what used to live across three pages — /pour, /availability,
 * /reconcile — into one consolidated wine list with rich row-actions.
 * The grid view (bin layout) survives as a toggle alongside the list.
 *
 * Data fetched here:
 *   • `wines`              → metadata + 86 status (canonical row source)
 *   • `inventory_items`    → bin location + sealed counts (aggregate)
 *   • `list_open_bottle_items` RPC → per-wine pour/open-bottle data
 *   • `cellar_config`      → optional grid layout for the Grid toggle
 *   • `restaurants`        → auto-86 settings (owner-only Settings modal)
 *
 * Joined client-side into a single CellarWineRow[]. Wines without a
 * by-the-glass list-item have null pour fields — the row UI gracefully
 * degrades to a sealed-only chip + bin location.
 */
export default async function CellarPage() {
  const auth = await getAuthContext();
  if (!auth) return null;

  const { supabase, restaurantId, restaurantName, userRole } = auth;

  const [
    { data: wineRows },
    { data: inventoryRows },
    { data: openBottleRows },
    { data: configRow },
    { data: restaurantRow },
  ] = await Promise.all([
    supabase
      .from("wines")
      .select(
        "id, name, producer, vintage, varietal, region, is_eightysixed, eightysixed_at, drink_window_start, drink_window_end, peak_year, rating, rating_source, review_excerpt",
      )
      .eq("restaurant_id", restaurantId)
      .order("name", { ascending: true }),
    supabase
      .from("inventory_items")
      .select("wine_id, bin_location, quantity")
      .eq("restaurant_id", restaurantId),
    supabase.rpc("list_open_bottle_items", { p_restaurant_id: restaurantId }),
    supabase
      .from("cellar_config")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("restaurants")
      .select("auto_eightysix_from_inventory, eightysix_ml_threshold")
      .eq("id", restaurantId)
      .single(),
  ]);

  // Aggregate inventory_items per wine: sum sealed count, pick the
  // first bin_location encountered (most wines live in one bin; multi-
  // bin layouts pick the first by db sort which is deterministic).
  const inventoryByWine = new Map<
    string,
    { sealed: number; bin: string | null }
  >();
  for (const item of inventoryRows ?? []) {
    if (!item.wine_id) continue;
    const prev = inventoryByWine.get(item.wine_id) ?? { sealed: 0, bin: null };
    prev.sealed += item.quantity ?? 0;
    if (!prev.bin && item.bin_location) prev.bin = item.bin_location;
    inventoryByWine.set(item.wine_id, prev);
  }

  // Index open-bottle RPC results by wine_id.
  const openByWine = new Map<string, OpenBottleRow>();
  for (const ob of (openBottleRows ?? []) as OpenBottleRow[]) {
    openByWine.set(ob.wine_id, ob);
  }

  // Build the unified row list. The wines table is canonical — every
  // wine in the cellar shows up, with optional stock data layered on.
  const rows: CellarWineRow[] = (wineRows ?? []).map((w) => {
    const inv = inventoryByWine.get(w.id) ?? { sealed: 0, bin: null };
    const ob = openByWine.get(w.id);
    return {
      wine_id: w.id,
      name: w.name,
      producer: w.producer,
      vintage: w.vintage,
      varietal: w.varietal,
      region: w.region,
      is_eightysixed: w.is_eightysixed ?? false,
      eightysixed_at: w.eightysixed_at,
      sealed_count: inv.sealed,
      bin_location: inv.bin,
      wine_list_item_id: ob?.wine_list_item_id ?? null,
      glass_pour_ml: ob?.glass_pour_ml ?? null,
      pour_size_mode: ob?.pour_size_mode ?? null,
      size_ml: ob?.size_ml ?? null,
      open_remaining_ml: ob?.open_remaining_ml ?? null,
      opened_at: ob?.opened_at ?? null,
      // BND-039 — drink window metadata (nullable)
      drink_window_start: w.drink_window_start,
      drink_window_end: w.drink_window_end,
      peak_year: w.peak_year,
      rating: w.rating,
      rating_source: w.rating_source,
      review_excerpt: w.review_excerpt,
    };
  });

  // Reconcile modal feed: only rows with a currently-open bottle. The
  // ReconcileList component already filters internally, but doing it
  // here keeps the prop simple.
  const reconcileItems: OpenBottleRow[] = ((openBottleRows ?? []) as OpenBottleRow[]).filter(
    (i) => i.open_remaining_ml !== null,
  );

  // Bin grid view data (kept from the prior /cellar page so the Grid
  // toggle continues to work).
  const gridData: GridData = {};
  for (const item of inventoryRows ?? []) {
    if (!item.bin_location || !item.wine_id) continue;
    const wine = (wineRows ?? []).find((w) => w.id === item.wine_id);
    if (!wine) continue;
    const bin = item.bin_location.toUpperCase().trim();
    if (!gridData[bin]) gridData[bin] = { wines: [], totalBottles: 0 };
    gridData[bin].wines.push({
      wineId: wine.id,
      name: wine.name,
      producer: wine.producer,
      vintage: wine.vintage,
      quantity: item.quantity ?? 0,
    });
    gridData[bin].totalBottles += item.quantity ?? 0;
  }

  return (
    <CellarShell
      rows={rows}
      reconcileItems={reconcileItems}
      cellarConfig={
        configRow
          ? {
              id: configRow.id,
              rows: configRow.rows,
              columns: configRow.columns,
              name: configRow.name,
            }
          : null
      }
      gridData={gridData}
      restaurantName={restaurantName}
      restaurantId={restaurantId}
      autoEightysixEnabled={restaurantRow?.auto_eightysix_from_inventory ?? false}
      autoEightysixThresholdMl={restaurantRow?.eightysix_ml_threshold ?? 148}
      role={userRole}
    />
  );
}
