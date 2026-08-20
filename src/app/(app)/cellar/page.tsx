import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { findDuplicateSuspects } from "@/lib/lineage/rollups";
import { CellarShell } from "./cellar-shell";
import { buildCellarBinData } from "./bin-data";
import type { CellarWineRow } from "./types";
import { isCellarHealthSegment } from "@/lib/cellar-health/classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Cellar" };

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
 *   • `inventory_items`    → bin location + sealed counts + section (aggregate)
 *   • `list_open_bottle_items` RPC → per-wine pour/open-bottle data
 *   • `cellar_config`      → optional grid layout + sections for the Grid toggle
 *   • `cellar_health`      → current per-wine health segment
 *   • `restaurants`        → auto-86 settings + eightysix_strategy (owner-only Settings modal)
 *
 * Joined client-side into a single CellarWineRow[]. Wines without a
 * by-the-glass list-item have null pour fields — the row UI gracefully
 * degrades to a sealed-only chip + bin location.
 */
export default async function CellarPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId, restaurantName, userRole } = auth;

  const [
    { data: wineRows },
    { data: inventoryRows, error: inventoryError },
    { data: binRows, error: binError },
    { data: openBottleRows },
    { data: healthRows, error: healthError },
    { data: configRow },
    { data: restaurantRow },
  ] = await Promise.all([
    supabase
      .from("wines")
      .select(
        "id, name, producer, vintage, varietal, region, country, lineage_id, size_ml, is_eightysixed, eightysixed_at, drink_window_start, drink_window_end, peak_year, rating, rating_source, review_excerpt, serving_temp_min, serving_temp_max, serving_temp_label, decant_minutes, retail_min, retail_max, retail_median, retail_retailer_count, retail_refreshed_at, pricing_target_pour_cost_pct, pricing_target_markup_ratio, pricing_dismissed_until, tasting_notes, hero_image_url, manual_overrides, colour",
      )
      .eq("restaurant_id", restaurantId)
      .order("name", { ascending: true }),
    supabase
      .from("inventory_items")
      .select("wine_id, bin_id, bin_location, quantity, unit_cost, added_at, section")
      .eq("restaurant_id", restaurantId)
      .order("added_at", { ascending: false }),
    supabase
      .from("bins")
      .select("id, code, zone, capacity, retired_at")
      .eq("restaurant_id", restaurantId)
      .order("priority", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true }),
    supabase.rpc("list_open_bottle_items", { p_restaurant_id: restaurantId }),
    supabase
      .from("cellar_health")
      .select("wine_id, segment")
      .eq("restaurant_id", restaurantId),
    supabase
      .from("cellar_config")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("restaurants")
      .select(
        "auto_eightysix_from_inventory, eightysix_ml_threshold, eightysix_strategy, default_target_pour_cost_pct, default_target_markup_ratio",
      )
      .eq("id", restaurantId)
      .single(),
  ]);

  if (inventoryError || binError || healthError) {
    throw inventoryError ?? binError ?? healthError;
  }

  // BND-040 — pull current bottle/glass prices from wine_list_items so
  // the drawer Pricing section can show actual pricing alongside retail
  // benchmark. A wine on multiple lists may have different prices; we
  // pick the most-recently-edited list AND surface its name so the
  // sommelier knows which list's price they're seeing (reviewer-find C3:
  // multi-list collision was previously silent, eroding trust when the
  // alert and drawer disagreed). Also count distinct lists so the UI
  // can show "+ N other lists" when relevant.
  const { data: listItemRows } = await supabase
    .from("wine_list_items")
    .select(
      "wine_id, bottle_price, glass_price, glass_pour_ml, updated_at, wine_list_sections!inner(wine_lists!inner(id, name, restaurant_id))",
    )
    .eq("wine_list_sections.wine_lists.restaurant_id", restaurantId)
    .order("updated_at", { ascending: false });
  type ListItemRow = {
    wine_id: string;
    bottle_price: number | null;
    glass_price: number | null;
    glass_pour_ml: number | null;
    wine_list_sections:
      | { wine_lists: { id: string; name: string; restaurant_id: string } | { id: string; name: string; restaurant_id: string }[] }
      | { wine_lists: { id: string; name: string; restaurant_id: string } | { id: string; name: string; restaurant_id: string }[] }[];
  };
  const priceByWine = new Map<
    string,
    {
      bottle: number | null;
      glass: number | null;
      pourMl: number | null;
      listName: string;
      otherListCount: number;
    }
  >();
  for (const item of ((listItemRows ?? []) as unknown as ListItemRow[])) {
    const sections = Array.isArray(item.wine_list_sections)
      ? item.wine_list_sections[0]
      : item.wine_list_sections;
    if (!sections) continue;
    const lists = Array.isArray(sections.wine_lists)
      ? sections.wine_lists[0]
      : sections.wine_lists;
    if (lists?.restaurant_id !== restaurantId) continue;
    const existing = priceByWine.get(item.wine_id);
    if (!existing) {
      priceByWine.set(item.wine_id, {
        bottle: item.bottle_price,
        glass: item.glass_price,
        pourMl: item.glass_pour_ml,
        listName: lists.name,
        otherListCount: 0,
      });
    } else if (existing.listName !== lists.name) {
      existing.otherListCount += 1;
    }
  }

  // Aggregate inventory_items per wine: sum sealed count, pick the
  // first bin_location and section encountered, capture most-recent
  // unit_cost (inventoryRows is ordered by added_at desc, so the
  // first item per wine_id is the most recent).
  const inventoryByWine = new Map<
    string,
    { sealed: number; bin: string | null; section: string | null; latestCost: number | null }
  >();
  for (const item of inventoryRows ?? []) {
    if (!item.wine_id) continue;
    const prev =
      inventoryByWine.get(item.wine_id) ?? {
        sealed: 0,
        bin: null,
        section: null,
        latestCost: null,
      };
    prev.sealed += item.quantity ?? 0;
    if (!prev.bin && item.bin_location) prev.bin = item.bin_location;
    if (!prev.section && item.section) prev.section = item.section;
    if (prev.latestCost == null && item.unit_cost != null) {
      prev.latestCost = item.unit_cost;
    }
    inventoryByWine.set(item.wine_id, prev);
  }

  // Index open-bottle RPC results by wine_id.
  const openByWine = new Map<string, OpenBottleRow>();
  for (const ob of (openBottleRows ?? []) as OpenBottleRow[]) {
    openByWine.set(ob.wine_id, ob);
  }

  const healthByWine = new Map(
    (healthRows ?? []).flatMap((row) =>
      isCellarHealthSegment(row.segment) ? [[row.wine_id, row.segment] as const] : [],
    ),
  );

  // OPP-1 (wave 0) — duplicate suspects: same lineage + vintage + format
  // pairs are merge candidates (EV-1.2). Computed here so the list can chip
  // them and the drawer can offer the merge.
  const suspectIdsByWine = new Map<string, string[]>();
  for (const suspect of findDuplicateSuspects(
    (wineRows ?? []).map((w) => ({
      id: w.id,
      lineageId: w.lineage_id,
      producer: w.producer,
      name: w.name,
      vintage: w.vintage,
      sizeMl: w.size_ml,
      quantity: 0,
      value: 0,
      unitCost: null,
    })),
  )) {
    for (const id of suspect.wineIds) {
      suspectIdsByWine.set(
        id,
        suspect.wineIds.filter((other) => other !== id),
      );
    }
  }

  const binDataByWine = buildCellarBinData({
    wines: (wineRows ?? []).map((wine) => ({
      id: wine.id,
      lineageId: wine.lineage_id,
      name: wine.name,
      producer: wine.producer,
      colour: wine.colour,
    })),
    bins: (binRows ?? []).map((bin) => ({
      id: bin.id,
      code: bin.code,
      zone: bin.zone,
      capacity: bin.capacity,
      retiredAt: bin.retired_at,
    })),
    inventoryRows: (inventoryRows ?? []).map((item) => ({
      wineId: item.wine_id,
      binId: item.bin_id,
      quantity: item.quantity ?? 0,
    })),
  });

  // Build the unified row list. The wines table is canonical — every
  // wine in the cellar shows up, with optional stock data layered on.
  const rows: CellarWineRow[] = (wineRows ?? []).map((w) => {
    const inv =
      inventoryByWine.get(w.id) ?? { sealed: 0, bin: null, section: null, latestCost: null };
    const binData = binDataByWine[w.id];
    const ob = openByWine.get(w.id);
    const price = priceByWine.get(w.id);
    return {
      wine_id: w.id,
      name: w.name,
      producer: w.producer,
      vintage: w.vintage,
      varietal: w.varietal,
      region: w.region,
      country: w.country,
      lineage_id: w.lineage_id,
      wine_size_ml: w.size_ml,
      duplicate_wine_ids: suspectIdsByWine.get(w.id) ?? [],
      is_eightysixed: w.is_eightysixed ?? false,
      eightysixed_at: w.eightysixed_at,
      tasting_notes: w.tasting_notes ?? null,
      hero_image_url: w.hero_image_url ?? null,
      healthSegment: healthByWine.get(w.id) ?? null,
      sealed_count: inv.sealed,
      bin_location: inv.bin,
      bin_placements: binData?.placements ?? [],
      unplaced_count: binData?.unplacedCount ?? 0,
      suggested_bin: binData?.suggestedBin ?? null,
      section: inv.section,
      wine_list_item_id: ob?.wine_list_item_id ?? null,
      glass_pour_ml: ob?.glass_pour_ml ?? price?.pourMl ?? null,
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
      serving_temp_min: w.serving_temp_min,
      serving_temp_max: w.serving_temp_max,
      serving_temp_label: w.serving_temp_label,
      decant_minutes: w.decant_minutes,
      manual_overrides: w.manual_overrides ?? [],
      colour: w.colour ?? null,
      // BND-040 — pricing intelligence (nullable)
      retail_min: w.retail_min,
      retail_max: w.retail_max,
      retail_median: w.retail_median,
      retail_retailer_count: w.retail_retailer_count,
      retail_refreshed_at: w.retail_refreshed_at,
      pricing_target_pour_cost_pct: w.pricing_target_pour_cost_pct,
      pricing_target_markup_ratio: w.pricing_target_markup_ratio,
      pricing_dismissed_until: w.pricing_dismissed_until,
      current_bottle_price: price?.bottle ?? null,
      current_glass_price: price?.glass ?? null,
      current_list_name: price?.listName ?? null,
      current_other_list_count: price?.otherListCount ?? 0,
      current_unit_cost: inv.latestCost,
      restaurant_default_target_pour_cost_pct:
        restaurantRow?.default_target_pour_cost_pct ?? null,
      restaurant_default_target_markup_ratio:
        restaurantRow?.default_target_markup_ratio ?? null,
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
  // BND-200 / PERF — Map-based lookup replaces O(n*m) .find()
  const wineById = new Map((wineRows ?? []).map((w) => [w.id, w]));
  const gridData: GridData = {};
  for (const item of inventoryRows ?? []) {
    if (!item.bin_location || !item.wine_id) continue;
    const wine = wineById.get(item.wine_id);
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

  // BND-063/064 — extract cellar sections from config
  const cellarSections: Array<{ id: string; name: string }> = (() => {
    const labels = configRow?.labels as Record<string, unknown> | null;
    if (labels?.sections && Array.isArray(labels.sections)) {
      return labels.sections as Array<{ id: string; name: string }>;
    }
    return [];
  })();

  const eightysixStrategy = restaurantRow?.eightysix_strategy === "mark" ? "mark" as const : "hide" as const;

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
              lowStockThreshold: configRow.low_stock_threshold ?? 3,
              reconcileVarianceThresholdOz: configRow.reconcile_variance_threshold_oz ?? 1.0,
            }
          : null
      }
      cellarSections={cellarSections}
      gridData={gridData}
      restaurantName={restaurantName}
      restaurantId={restaurantId}
      autoEightysixEnabled={restaurantRow?.auto_eightysix_from_inventory ?? false}
      autoEightysixThresholdMl={restaurantRow?.eightysix_ml_threshold ?? 148}
      eightysixStrategy={eightysixStrategy}
      defaultTargetPourCostPct={restaurantRow?.default_target_pour_cost_pct ?? null}
      defaultTargetMarkupRatio={restaurantRow?.default_target_markup_ratio ?? null}
      role={userRole}
    />
  );
}
