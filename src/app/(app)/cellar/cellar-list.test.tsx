import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";
import type { CellarWineRow } from "./types";
import { CellarList } from "./cellar-list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function renderList(rows: CellarWineRow[]) {
  return renderToStaticMarkup(
    <ToastProvider>
      <CellarList
        rows={rows}
        query=""
        filter="all"
        onSelectWine={() => {}}
        onResetFilters={() => {}}
        facets={{}}
        groupBy={null}
        sort={null}
        onFacetsChange={() => {}}
        onGroupByChange={() => {}}
      />
    </ToastProvider>,
  );
}

describe("CellarList row thumbnails", () => {
  it("renders a label thumbnail for a row with hero_image_url", () => {
    const markup = renderList([
      row({ wine_id: "wine-1", hero_image_url: "https://example.test/wine-1.jpg" }),
    ]);

    expect(markup).toContain("https://example.test/wine-1.jpg");
  });

  it("renders no image element for a row without hero_image_url", () => {
    const markup = renderList([row({ wine_id: "wine-1", hero_image_url: null })]);

    expect(markup).not.toContain("<img");
  });
});

function row(overrides: Partial<CellarWineRow>): CellarWineRow {
  return {
    wine_id: "wine-1",
    name: "Test Wine",
    healthSegment: null,
    producer: "Producer",
    vintage: 2024,
    varietal: "Pinot Noir",
    region: "Willamette Valley",
    country: "USA",
    lineage_id: null,
    wine_size_ml: 750,
    duplicate_wine_ids: [],
    is_eightysixed: false,
    eightysixed_at: null,
    tasting_notes: null,
    hero_image_url: null,
    sealed_count: 1,
    bin_location: null,
    bin_placements: [],
    unplaced_count: 0,
    suggested_bin: null,
    section: null,
    wine_list_item_id: null,
    glass_pour_ml: null,
    pour_size_mode: null,
    size_ml: 750,
    open_remaining_ml: null,
    opened_at: null,
    open_bottle_id: null,
    preservation_method: "none",
    opened_by: null,
    theoretical_remaining_ml: null,
    closeout_reason_codes: [],
    stock_adjustment_reason_codes: [],
    drink_window_start: null,
    drink_window_end: null,
    peak_year: null,
    rating: null,
    rating_source: null,
    review_excerpt: null,
    manual_overrides: [],
    colour: null,
    serving_temp_min: null,
    serving_temp_max: null,
    serving_temp_label: null,
    decant_minutes: null,
    retail_min: null,
    retail_max: null,
    retail_median: null,
    retail_retailer_count: null,
    retail_refreshed_at: null,
    current_bottle_price: null,
    current_glass_price: null,
    current_list_name: null,
    current_other_list_count: 0,
    current_unit_cost: null,
    pricing_target_pour_cost_pct: null,
    pricing_target_markup_ratio: null,
    pricing_dismissed_until: null,
    restaurant_default_target_pour_cost_pct: null,
    restaurant_default_target_markup_ratio: null,
    ...overrides,
  };
}
