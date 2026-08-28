import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
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
// M2-15 §2.4: the facet bar only renders a control (and only renders at
// all) when the current rows give it more than one selectable option, so
// this second row exists purely to keep Producer/Region diversified for
// the "route reachable" test below — it's otherwise inert (not open, not
// low, not 86'd, no drink-window data) so it doesn't perturb any of that
// test's other counter/button assertions.
const secondRow: CellarWineRow = {
  ...openRow,
  wine_id: "wine-2",
  producer: "Second Producer",
  region: "Second Region",
  open_remaining_ml: null,
  opened_at: null,
  open_bottle_id: null,
  sealed_count: 12,
};
const reconcileRow: OpenBottleRow = {
  wine_id: "wine-1",
  wine_list_item_id: "item-1",
  producer: "Test Producer",
  name: "Test Wine",
  vintage: 2022,
  size_ml: 750,
  sealed_count: 0,
  opened_at: "2026-08-20T12:00:00.000Z",
  open_remaining_ml: 300,
  glass_pour_ml: 148,
  pour_size_mode: "fixed",
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
            rows={[openRow, secondRow]}
            reconcileItems={[reconcileRow]}
            cellarConfig={{
              id: "cellar-1",
              rows: 12,
              columns: 16,
              name: "Main cellar",
              lowStockThreshold: 2,
              reconcileVarianceThresholdOz: 1.5,
            }}
            gridData={{}}
            restaurantName="Test Restaurant"
            restaurantId="restaurant-1"
            autoEightysixEnabled={false}
            autoEightysixThresholdMl={148}
            eightysixStrategy="hide"
            defaultTargetPourCostPct={null}
            defaultTargetMarkupRatio={null}
            // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is CellarShell's own RBAC prop ("owner"/"staff"/"admin"), not a DOM ARIA role.
            role="owner"
            cellarSections={[{ id: "section-1", name: "Main cellar" }]}
          />
        </ToastProvider>,
      );
    });

    const link = getByRole(container, "link", { name: /open bottles/i });
    expect(link.getAttribute("href")).toBe("/cellar/open");
    expect(link.textContent).toMatch(/1/);
    expect(link.className).toMatch(/(?:^|\s)(?:h-11|min-h-11)(?:\s|$)/);

    expect(container.querySelector("section")?.className).toContain(
      "overflow-x-hidden",
    );
    container.querySelectorAll('[role="tab"]').forEach((tab) => {
      expect(tab.className).toContain("min-h-11");
    });
    expect(
      container.querySelector('[role="tablist"]')?.className.split(" "),
    ).toContain("flex-wrap");
    // M2-15 §2.4 residuals audit: the compact control row (Producer/Region +
    // Filters) must read as ONE row down to 320px rather than wrapping into a
    // multi-row block, so it's flex-nowrap (with overflow-x-auto as a
    // fallback) — not flex-wrap. The applied-filter chip row is a separate
    // sibling that still wraps.
    expect(
      container
        .querySelector('[data-cellar-facet-bar] > div')
        ?.className.split(" "),
    ).toEqual(expect.arrayContaining(["flex-nowrap", "overflow-x-auto"]));
    expect(link.parentElement?.className).toContain("w-full");
    expect(link.parentElement?.className).toContain("flex-wrap");
    const desktopSearch = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search name, producer, region…"]',
    )!;
    expect(desktopSearch.className).toContain("h-11");
    container.querySelectorAll("[data-cellar-facet-bar] select").forEach((select) => {
      expect(select.className.split(" ")).toContain("h-11");
      expect(select.className.split(" ")).not.toContain("md:h-9");
    });
    for (const label of ["List view", "Grid view"]) {
      const control = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      expect(control.className).toContain("h-11");
      expect(control.className).toContain("w-11");
    }
    for (const label of ["Search wines", "Cellar settings", "Drag to reorder"]) {
      const control = container.querySelector<HTMLElement>(
        `[aria-label="${label}"]`,
      );
      expect(control, label).not.toBeNull();
      expect(control?.className, label).toContain("w-11");
      expect(control?.className, label).toContain("h-11");
    }
    for (const label of ["Reconcile 1 open bottle →", "Select wines", "Show"]) {
      const control = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      );
      expect(control, label).not.toBeUndefined();
      expect(control?.className, label).toContain("min-h-11");
    }
  });

  it("starts multi-vintage lineages collapsed and expands them on demand", () => {
    const lineageRows = [
      { ...openRow, lineage_id: "lineage-1" },
      {
        ...openRow,
        wine_id: "wine-2",
        vintage: 2021,
        lineage_id: "lineage-1",
      },
    ];

    act(() => {
      root.render(
        <ToastProvider>
          <CellarShell
            rows={lineageRows}
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
            // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is CellarShell's own RBAC prop ("owner"/"staff"/"admin"), not a DOM ARIA role.
            role="staff"
          />
        </ToastProvider>,
      );
    });

    const header = container.querySelector<HTMLButtonElement>(
      "[data-lineage-header]",
    )!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-lineage-children]")).toBeNull();

    act(() => header.click());

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-lineage-children]")).not.toBeNull();
  });

  it("renders large cellars incrementally without hiding the remaining count", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      ...openRow,
      wine_id: `wine-${index + 1}`,
      name: `Wine ${index + 1}`,
      section: "Main cellar",
    }));

    act(() => {
      root.render(
        <ToastProvider>
          <CellarShell
            rows={rows}
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
            // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is CellarShell's own RBAC prop ("owner"/"staff"/"admin"), not a DOM ARIA role.
            role="staff"
            cellarSections={[{ id: "section-1", name: "Main cellar" }]}
          />
        </ToastProvider>,
      );
    });

    expect(container.querySelectorAll('[aria-label="Drag to reorder"]')).toHaveLength(
      50,
    );
    const showMore = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Show 10 more"),
    )!;
    expect(showMore.textContent).toContain("50 of 60");
    expect(showMore.className).toContain("min-h-11");

    act(() => showMore.click());

    expect(container.querySelectorAll('[aria-label="Drag to reorder"]')).toHaveLength(
      60,
    );
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
