import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CellarRow } from "./cellar-row";
import type { CellarWineRow } from "./types";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

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

describe("CellarRow", () => {
  it("renders producer, name, and vintage", () => {
    const markup = renderToStaticMarkup(
      <CellarRow row={row({ producer: "Domaine X", name: "Cuvée Y", vintage: 2019 })} onSelect={() => {}} />,
    );
    expect(markup).toContain("Domaine X");
    expect(markup).toContain("Cuvée Y");
    expect(markup).toContain("2019");
  });

  it("renders the 86'd chip for an eightysixed wine", () => {
    const markup = renderToStaticMarkup(
      <CellarRow row={row({ is_eightysixed: true })} onSelect={() => {}} />,
    );
    expect(markup).toContain("86&#x27;d");
  });

  it("renders no drag handle when dragHandle is not provided", () => {
    const markup = renderToStaticMarkup(<CellarRow row={row()} onSelect={() => {}} />);
    expect(markup).not.toContain("Drag to reorder");
  });

  it("renders a drag handle when dragHandle is provided", () => {
    const markup = renderToStaticMarkup(
      <CellarRow
        row={row()}
        onSelect={() => {}}
        dragHandle={{ attributes: {}, listeners: {} }}
      />,
    );
    expect(markup).toContain("Drag to reorder");
  });

  it("calls onToggleSelect (not onSelect) when the selection checkbox is clicked in select mode", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const onSelect = vi.fn();
    const onToggleSelect = vi.fn();
    act(() => {
      root!.render(
        <CellarRow
          row={row()}
          onSelect={onSelect}
          selectMode
          selected={false}
          onToggleSelect={onToggleSelect}
        />,
      );
    });

    const checkbox = container.querySelector('button[aria-label="Select"]') as HTMLButtonElement;
    act(() => {
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
