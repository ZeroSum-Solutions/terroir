import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";
import type { CellarWineRow } from "./types";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/cellar",
}));

const { CellarShell } = await import("./cellar-shell");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const openRow: CellarWineRow = {
  wine_id: "wine-1",
  name: "Test Wine",
  producer: "Test Producer",
  vintage: 2022,
  varietal: null,
  region: null,
  country: null,
  is_eightysixed: false,
  eightysixed_at: null,
  tasting_notes: null,
  hero_image_url: null,
  healthSegment: null,
  lineage_id: null,
  wine_size_ml: 750,
  duplicate_wine_ids: [],
  sealed_count: 0,
  bin_location: null,
  bin_placements: [],
  unplaced_count: 0,
  suggested_bin: null,
  section: null,
  wine_list_item_id: "item-1",
  glass_pour_ml: 148,
  pour_size_mode: "fixed",
  size_ml: 750,
  open_remaining_ml: 300,
  opened_at: "2026-08-20T12:00:00.000Z",
  open_bottle_id: "open-bottle-1",
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
  pricing_target_pour_cost_pct: null,
  pricing_target_markup_ratio: null,
  pricing_dismissed_until: null,
  current_bottle_price: null,
  current_glass_price: null,
  current_list_name: null,
  current_other_list_count: 0,
  current_unit_cost: null,
  restaurant_default_target_pour_cost_pct: null,
  restaurant_default_target_markup_ratio: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CellarShell open bottles route", () => {
  it("keeps the open bottles route reachable without reconciliation items", () => {
    act(() => {
      root.render(
        <ToastProvider>
          <CellarShell
            rows={[openRow]}
            reconcileItems={[]}
            cellarConfig={null}
            gridData={{}}
            restaurantName="Test Restaurant"
            restaurantId="restaurant-1"
            autoEightysixEnabled={false}
            autoEightysixThresholdMl={148}
            eightysixStrategy="hide"
            defaultTargetPourCostPct={null}
            defaultTargetMarkupRatio={null}
            role="staff"
          />
        </ToastProvider>,
      );
    });

    const link = getByRole(container, "link", { name: /open bottles/i });
    expect(link.getAttribute("href")).toBe("/cellar/open");
    expect(link.textContent).toMatch(/1/);
    expect(link.className).toMatch(/(?:^|\s)(?:h-11|min-h-11)(?:\s|$)/);
  });
});

function getByRole(
  container: HTMLElement,
  role: string,
  { name }: { name: RegExp },
) {
  const matches = [...container.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      getRole(element) === role &&
      !isHiddenFromAccessibility(element) &&
      name.test(getAccessibleName(element)),
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

function getRole(element: HTMLElement) {
  const explicitRole = element.getAttribute("role")?.trim();
  if (explicitRole) return explicitRole.split(/\s+/, 1)[0];
  return element.matches("a[href]") ? "link" : null;
}

function isHiddenFromAccessibility(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const styles = getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      styles.display === "none" ||
      styles.visibility === "hidden"
    ) {
      return true;
    }
  }
  return false;
}

function getAccessibleName(element: HTMLElement) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  return element.getAttribute("aria-label") ?? element.textContent ?? "";
}
