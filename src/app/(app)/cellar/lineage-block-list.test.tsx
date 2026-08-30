import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildLineageBlocks, LineageBlockList } from "./lineage-block-list";
import type { CellarWineRow } from "./types";

function row(overrides: Partial<CellarWineRow> = {}): CellarWineRow {
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

describe("buildLineageBlocks", () => {
  it("renders a wine with no lineage siblings as a plain single block", () => {
    const w = row({ wine_id: "solo", lineage_id: null });
    const blocks = buildLineageBlocks([w], false);
    expect(blocks).toEqual([{ kind: "single", row: w }]);
  });

  it("renders a lone lineage member (no siblings sharing the id) as a single block", () => {
    const w = row({ wine_id: "solo", lineage_id: "lineage-a" });
    const blocks = buildLineageBlocks([w], false);
    expect(blocks).toEqual([{ kind: "single", row: w }]);
  });

  it("groups 2+ wines sharing a lineage_id into one lineage block, newest vintage first by default", () => {
    const older = row({ wine_id: "w-2018", lineage_id: "lineage-a", vintage: 2018 });
    const newer = row({ wine_id: "w-2020", lineage_id: "lineage-a", vintage: 2020 });
    const blocks = buildLineageBlocks([older, newer], false);

    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.kind).toBe("lineage");
    if (block.kind === "lineage") {
      expect(block.rows.map((r) => r.wine_id)).toEqual(["w-2020", "w-2018"]);
      expect(block.span).toEqual([2018, 2020]);
      expect(block.totalBottles).toBe(2);
    }
  });

  it("preserves incoming order for lineage siblings when preserveOrder is true", () => {
    const older = row({ wine_id: "w-2018", lineage_id: "lineage-a", vintage: 2018 });
    const newer = row({ wine_id: "w-2020", lineage_id: "lineage-a", vintage: 2020 });
    const blocks = buildLineageBlocks([older, newer], true);

    const [block] = blocks;
    expect(block.kind).toBe("lineage");
    if (block.kind === "lineage") {
      expect(block.rows.map((r) => r.wine_id)).toEqual(["w-2018", "w-2020"]);
    }
  });
});

describe("LineageBlockList", () => {
  it("renders lineage blocks collapsed by default, showing only the header row", () => {
    const older = row({ wine_id: "w-2018", lineage_id: "lineage-a", vintage: 2018, name: "Old Vintage Row" });
    const newer = row({ wine_id: "w-2020", lineage_id: "lineage-a", vintage: 2020, name: "New Vintage Row" });
    const markup = renderToStaticMarkup(
      <LineageBlockList wines={[older, newer]} renderRow={(r) => <span>{r.name}</span>} />,
    );
    expect(markup).toContain('data-lineage-header');
    expect(markup).not.toContain('data-lineage-children');
  });

  it("renders a plain (non-lineage) wine directly via renderRow", () => {
    const solo = row({ wine_id: "solo", name: "Solo Wine" });
    const markup = renderToStaticMarkup(
      <LineageBlockList wines={[solo]} renderRow={(r) => <span>{r.name}</span>} />,
    );
    expect(markup).toContain("Solo Wine");
    expect(markup).not.toContain('data-lineage-header');
  });
});
