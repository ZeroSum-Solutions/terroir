/**
 * What this restaurant's own records say about one wine: stock, cost, list
 * membership, movement.
 *
 * The third of the three composable resolvers in §4.2 of
 * docs/superpowers/specs/2026-09-03-wine-page-design.md. It reads the cellar
 * and nothing else — no reference data, no drink window. The Drink-now badge
 * needs the window, so the badges are composed AFTER both resolvers settle,
 * by `composeBadges` below, which is pure. A cellar resolver that reached for
 * reference data to compute a badge would make the composable split a
 * fiction.
 *
 * Every query is scoped to `restaurantId` explicitly as well as by RLS: the
 * page is keyed on a UUID from the URL, which is exactly where a tenant slip
 * would leak a neighbour's stock.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DEFAULT_HEALTH_THRESHOLDS } from "@/lib/cellar-health/classify";
import type { Sourced } from "@/lib/provenance/sourced";
import { computeBadges, type Badge } from "./badges";
import type { DrinkWindow } from "./resolve-reference-profile";

export type InventoryRow = {
  quantity: number;
  unit_cost: number;
  added_at: string;
  bin_location: string | null;
  section: string | null;
  format: string | null;
};

export type ListRow = {
  bottle_price: number | null;
  hidden: boolean;
  is_available: boolean;
  wine_list_sections: { wine_lists: { is_published: boolean; archived: boolean } | null } | null;
};

export type CellarFacts = {
  sellingFormatUnits: number;
  otherFormatUnits: number;
  bottleCount: number;
  locations: string[];
  /** YYYY-MM-DD, the latest put-away across every lot. */
  lastPutAwayAt: string | null;
  /** YYYY-MM-DD, the latest DEPLETING pour. Spills and reconciles do not count. */
  lastDepletionAt: string | null;
  deadStockDays: number;
  /** The lowest price on any list row a guest can actually order from. */
  publishedBottlePrice: number | null;
  weightedUnitCost: number | null;
  listedAndOrderable: boolean;
};

/**
 * Whether a lot is in the format the wine is sold in. `format` is free text
 * from invoice scans ("750ml", "magnum", "half") and null on every lot that
 * predates the column — null is the selling format, because counting those
 * as "other" would make Last bottle fire on a cellar with a case on hand.
 */
export function isSellingFormat(format: string | null, sizeMl: number | null): boolean {
  if (format === null) return true;
  const ml = /^\s*(\d+)\s*ml\s*$/i.exec(format);
  if (ml === null) return false;
  return Number(ml[1]) === (sizeMl ?? 750);
}

export function deriveCellarFacts({
  inventory,
  lastDepletionAt,
  lists,
  deadStockDays,
  sizeMl,
}: {
  inventory: InventoryRow[];
  lastDepletionAt: string | null;
  lists: ListRow[];
  deadStockDays: number;
  sizeMl: number | null;
}): CellarFacts {
  let selling = 0;
  let other = 0;
  let costWeight = 0;
  let costUnits = 0;
  let latestPutAway: string | null = null;
  for (const lot of inventory) {
    if (isSellingFormat(lot.format, sizeMl)) selling += lot.quantity;
    else other += lot.quantity;
    // Zero-quantity lots are history and a zero cost is "unknown", not free.
    if (lot.quantity > 0 && lot.unit_cost > 0) {
      costWeight += lot.quantity * lot.unit_cost;
      costUnits += lot.quantity;
    }
    if (latestPutAway === null || lot.added_at > latestPutAway) latestPutAway = lot.added_at;
  }

  const orderable = lists.filter(
    (row) =>
      !row.hidden &&
      row.is_available &&
      row.wine_list_sections?.wine_lists?.is_published === true &&
      row.wine_list_sections.wine_lists.archived === false,
  );
  const prices = orderable
    .map((row) => row.bottle_price)
    .filter((price): price is number => price !== null && price > 0);

  return {
    sellingFormatUnits: selling,
    otherFormatUnits: other,
    bottleCount: selling + other,
    locations: [
      ...new Set(
        inventory
          .map((lot) => lot.bin_location ?? lot.section)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    lastPutAwayAt: latestPutAway === null ? null : latestPutAway.slice(0, 10),
    lastDepletionAt,
    deadStockDays,
    publishedBottlePrice: prices.length === 0 ? null : Math.min(...prices),
    weightedUnitCost: costUnits === 0 ? null : costWeight / costUnits,
    listedAndOrderable: orderable.length > 0,
  };
}

/**
 * The badges, computed once the cellar and the window are both known. Only a
 * sourced or house-set window may raise Drink now; any other basis on a window
 * is passed through as "no basis", so it cannot open a bottle.
 */
export function composeBadges(
  facts: CellarFacts,
  window: Sourced<DrinkWindow> | null,
  asOf: string,
): Sourced<Badge[]> {
  const windowBasis =
    window === null
      ? null
      : window.basis.kind === "sourced" || window.basis.kind === "override"
        ? window.basis.kind
        : null;
  return {
    value: computeBadges({
      asOf,
      window: windowBasis === null ? null : window!.value,
      windowBasis,
      sellingFormatUnits: facts.sellingFormatUnits,
      otherFormatUnits: facts.otherFormatUnits,
      lastPutAwayAt: facts.lastPutAwayAt,
      lastDepletionAt: facts.lastDepletionAt,
      deadStockDays: facts.deadStockDays,
      publishedBottlePrice: facts.publishedBottlePrice,
      weightedUnitCost: facts.weightedUnitCost,
      listedAndOrderable: facts.listedAndOrderable,
    }),
    basis: { kind: "measured", asOf },
  };
}

export async function resolveCellarContext(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  wineId: string,
  sizeMl: number | null,
): Promise<CellarFacts> {
  const [inventory, lastPour, lists, config] = await Promise.all([
    supabase
      .from("inventory_items")
      .select("quantity, unit_cost, added_at, bin_location, section, format")
      .eq("wine_id", wineId)
      .eq("restaurant_id", restaurantId),
    // 'pour' is the one depleting kind. spill is waste, reconcile is an
    // adjustment, new_bottle/finish_bottle are lifecycle — none of them is a
    // sale, and a badge cleared by a spill is the noise the audit named.
    supabase
      .from("pour_events")
      .select("occurred_at")
      .eq("wine_id", wineId)
      .eq("restaurant_id", restaurantId)
      .eq("kind", "pour")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("wine_list_items")
      .select("bottle_price, hidden, is_available, wine_list_sections(wine_lists(is_published, archived))")
      .eq("wine_id", wineId)
      .eq("restaurant_id", restaurantId),
    supabase
      .from("cellar_config")
      .select("health_dead_stock_days")
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
  ]);

  // A failed inventory read must not become "None on hand": that is a stock
  // claim invented out of an outage.
  if (inventory.error) throw inventory.error;
  if (lastPour.error) throw lastPour.error;
  if (lists.error) throw lists.error;
  if (config.error) throw config.error;

  return deriveCellarFacts({
    inventory: inventory.data ?? [],
    lastDepletionAt: lastPour.data?.occurred_at.slice(0, 10) ?? null,
    lists: lists.data ?? [],
    deadStockDays: config.data?.health_dead_stock_days ?? DEFAULT_HEALTH_THRESHOLDS.deadStockDays,
    sizeMl,
  });
}
