/**
 * CellarWineRow — unified row shape that absorbs the per-wine data from
 * what used to be three separate pages (Pour / Availability / Reconcile).
 *
 * The Cellar single-screen consolidation (Phase 2 IA redesign) shows
 * every wine in one list with stock + availability + bin info inline.
 * This shape is built on the server in cellar/page.tsx by joining:
 *
 *   - `wines` table        → metadata + 86 status
 *   - `inventory_items`    → bin location + sealed count
 *   - `list_open_bottle_items` RPC → open-bottle ml + glass pour size
 *
 * Wines without a wine_list_item with pour size won't have stock fields
 * populated — those rows render with a stock chip that says "Sealed only"
 * (or the like). Pouring requires a glass_pour_ml, which means the wine
 * has been added to a list with a pour size.
 */
export type CellarWineRow = {
  // From wines
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  is_eightysixed: boolean;
  eightysixed_at: string | null;

  // From inventory_items (aggregate)
  sealed_count: number;
  bin_location: string | null;

  // From list_open_bottle_items RPC (only set if wine has a list-item
  // with pour size — i.e. it's by-the-glass).
  wine_list_item_id: string | null;
  glass_pour_ml: number | null;
  pour_size_mode: string | null;
  size_ml: number | null;
  open_remaining_ml: number | null;
  opened_at: string | null;
};
