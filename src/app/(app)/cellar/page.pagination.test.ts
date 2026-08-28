import { describe, expect, it, vi } from "vitest";

/**
 * SCALE: PostgREST caps a single response at db.max_rows (1000 — see
 * supabase/config.toml). The cellar page's `wines` and `inventory_items`
 * reads used to fetch with no `.range()`, so a restaurant with more than
 * 1000 wines (or inventory line items) had rows silently dropped from
 * the cellar list with no error surfaced anywhere. This test proves the
 * read now pages to exhaustion instead of truncating.
 */

const mocks = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));

const { default: CellarPage } = await import("./page");
const { CellarShell } = await import("./cellar-shell");

type Resp = { data: unknown[] | null; error: unknown };

function makeSupabase(opts: { wines: unknown[]; inventoryItems: unknown[] }) {
  const ranges: Record<string, Array<[number, number]>> = {
    wines: [],
    inventory_items: [],
  };
  const paginated: Record<string, unknown[]> = {
    wines: opts.wines,
    inventory_items: opts.inventoryItems,
  };
  const immediate: Record<string, unknown[]> = {
    bins: [],
    open_bottles: [],
    reason_codes: [],
    cellar_health: [],
    wine_list_items: [],
    pour_events: [],
  };

  function chain(table: string) {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "is", "limit", "in", "gte", "neq", "not"]) {
      self[method] = () => self;
    }
    self.range = async (from: number, to: number) => {
      ranges[table]?.push([from, to]);
      const source = paginated[table] ?? [];
      return { data: source.slice(from, to + 1), error: null };
    };
    self.single = async () => {
      if (table === "restaurants") {
        return {
          data: {
            auto_eightysix_from_inventory: false,
            eightysix_ml_threshold: 148,
            eightysix_strategy: "hide",
            default_target_pour_cost_pct: null,
            default_target_markup_ratio: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    self.maybeSingle = async () => ({ data: null, error: null });
    self.then = (resolve: (v: Resp) => void) =>
      resolve({ data: immediate[table] ?? [], error: null });
    return self;
  }

  return {
    ranges,
    from: (table: string) => chain(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

function makeWine(i: number) {
  const id = `wine-${String(i).padStart(4, "0")}`;
  return {
    id,
    name: `Wine ${String(i).padStart(4, "0")}`,
    producer: "Producer",
    vintage: 2020,
    varietal: null,
    region: null,
    country: null,
    lineage_id: null,
    size_ml: 750,
    is_eightysixed: false,
    eightysixed_at: null,
    drink_window_start: null,
    drink_window_end: null,
    peak_year: null,
    rating: null,
    rating_source: null,
    review_excerpt: null,
    serving_temp_min: null,
    serving_temp_max: null,
    serving_temp_label: null,
    decant_minutes: null,
    retail_min: null,
    retail_max: null,
    retail_median: null,
    retail_retailer_count: null,
    retail_refreshed_at: null,
    pricing_target_pour_cost_pct: null,
    pricing_target_markup_ratio: null,
    pricing_dismissed_until: null,
    tasting_notes: null,
    hero_image_url: null,
    manual_overrides: [],
    colour: null,
  };
}

function makeInventoryItem(i: number) {
  return {
    wine_id: `wine-${String(i % 1001).padStart(4, "0")}`,
    bin_id: null,
    bin_location: null,
    quantity: 1,
    unit_cost: 10,
    added_at: new Date(2026, 0, 1).toISOString(),
    section: null,
  };
}

describe("CellarPage cellar-scale read pagination", () => {
  it("pages past the PostgREST 1000-row cap instead of silently truncating the cellar", async () => {
    const wines = Array.from({ length: 1001 }, (_, i) => makeWine(i));
    const inventoryItems = Array.from({ length: 1001 }, (_, i) => makeInventoryItem(i));
    const supabase = makeSupabase({ wines, inventoryItems });

    mocks.getAuthContext.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
      restaurantName: "House",
      userRole: "owner",
    });

    const element = await CellarPage();

    expect(element.type).toBe(CellarShell);
    expect(element.props.rows).toHaveLength(1001);
    expect(supabase.ranges.wines).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(supabase.ranges.inventory_items).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});
