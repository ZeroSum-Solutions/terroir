import {
  corpusImageFromEmbed,
} from "@/lib/wine-intelligence/corpus-image";
import type { XWinesImageKind } from "@/lib/wine-intelligence/xwines-profile";
import type { CellarHealthSegment } from "@/lib/cellar-health/classify";

/**
 * CellarWineRow — unified row shape that absorbs the per-wine data from
 * what used to be three separate pages (Pour / Availability / Reconcile).
 *
 * The Cellar single-screen consolidation (Phase 2 IA redesign) shows
 * every wine in one list with stock + availability + bin info inline.
 * This shape is built on the server in cellar/page.tsx by joining:
 *
 *   - `wines` table        → metadata + 86 status
 *   - `inventory_items`    → bin location + sealed count + section
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
  country: string | null;
  is_eightysixed: boolean;
  eightysixed_at: string | null;
  tasting_notes: string | null;
  hero_image_url: string | null;
  /**
   * GLOBAL-04 — the corpus stand-in for a wine with no photograph of its own,
   * from its identity link. Optional so existing row fixtures stay valid.
   */
  corpus_image?: { url: string; kind: XWinesImageKind } | null;
  healthSegment: CellarHealthSegment | null;

  // OPP-1 (wave 0) — lineage identity. lineage_id groups vintage siblings
  // of one producer-cuvée; wine_size_ml is the wine's own bottle format
  // (distinct from the open-bottle `size_ml` below, which only exists for
  // BTG wines); duplicate_wine_ids lists same-lineage/vintage/format twins
  // proposed for merge (EV-1.2).
  lineage_id: string | null;
  wine_size_ml: number;
  duplicate_wine_ids: string[];

  // From inventory_items (aggregate)
  sealed_count: number;
  bin_location: string | null;
  bin_placements: Array<{
    binId: string;
    code: string;
    zone: string | null;
    quantity: number;
  }>;
  unplaced_count: number;
  suggested_bin: {
    binId: string;
    code: string;
    zone: string | null;
    reason: "same_lineage" | "same_colour_zone";
  } | null;
  // BND-063/064 — cellar section from inventory_items.section
  section: string | null;

  // From list_open_bottle_items RPC (only set if wine has a list-item
  // with pour size — i.e. it's by-the-glass).
  wine_list_item_id: string | null;
  glass_pour_ml: number | null;
  pour_size_mode: string | null;
  size_ml: number | null;
  open_remaining_ml: number | null;
  opened_at: string | null;
  open_bottle_id: string | null;
  preservation_method: "coravin" | "argon" | "vacuum" | "none";
  opened_by: string | null;
  theoretical_remaining_ml: number | null;
  closeout_reason_codes: Array<{
    id: string;
    label: string;
    category: string;
  }>;
  stock_adjustment_reason_codes: Array<{
    id: string;
    label: string;
    category: string;
  }>;

  // BND-039 — drink-window enrichment metadata. All nullable so a wine
  // without enrichment data renders with no timeline / no panel; the
  // UI gracefully degrades.
  drink_window_start: number | null;
  drink_window_end: number | null;
  peak_year: number | null;
  rating: number | null;
  rating_source: string | null;
  review_excerpt: string | null;
  // BND-277 — manual field overrides (#72, #78).
  manual_overrides: string[];
  colour: string | null;

  // BND-069/BND-070 — serving temp + decant enrichment metadata.
  serving_temp_min: number | null;
  serving_temp_max: number | null;
  serving_temp_label: string | null;
  decant_minutes: number | null;

  // BND-040 — pricing intelligence. All nullable so wines without retail
  // data render the drawer without a Pricing section. Targets resolve to
  // restaurant default at the helper layer when null.
  retail_min: number | null;
  retail_max: number | null;
  retail_median: number | null;
  retail_retailer_count: number | null;
  retail_refreshed_at: string | null;
  pricing_target_pour_cost_pct: number | null;
  pricing_target_markup_ratio: number | null;
  pricing_dismissed_until: string | null;
  // The current bottle list / glass list when the wine appears on a
  // restaurant list. Pulled from wine_list_items via aggregator (most
  // common price across multiple lists, or first one). Null when not
  // on any list.
  current_bottle_price: number | null;
  current_glass_price: number | null;
  // Most-recently-edited wine_list this price came from (multi-list
  // disclosure — reviewer-find C3). Null when wine isn't on any list.
  current_list_name: string | null;
  // Count of OTHER lists this wine appears on. Drawer shows "+ N other
  // lists" when > 0 so the sommelier knows pricing may differ elsewhere.
  current_other_list_count: number;
  // Most-recent invoice cost — drives pour-cost % calculation.
  current_unit_cost: number | null;
  // Restaurant-level defaults (passed through from the page so the
  // drawer's helpers can resolve effective targets without another fetch).
  restaurant_default_target_pour_cost_pct: number | null;
  restaurant_default_target_markup_ratio: number | null;
};

/**
 * The two image fields of a row, from a `wines` select that embeds the
 * identity link's corpus entry. Kept beside the row shape because that is
 * what it produces — and because it lets the cellar page fill both fields
 * from one spread.
 */
export function wineRowImages(wine: {
  hero_image_url: string | null;
  canonical_wines: unknown;
}): Pick<CellarWineRow, "hero_image_url" | "corpus_image"> {
  return {
    hero_image_url: wine.hero_image_url ?? null,
    corpus_image: corpusImageFromEmbed(wine.canonical_wines),
  };
}
