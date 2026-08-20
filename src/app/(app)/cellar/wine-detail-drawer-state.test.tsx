import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";
import type { CellarWineRow } from "./types";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { drawerStateKey, WineDetailDrawer } = await import("./wine-detail-drawer");

describe("WineDetailDrawer bottle state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("resets preservation and close-out values when switching drawer wines", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const first = row({
      wine_id: "wine-1",
      opened_at: "2026-08-18T10:00:00.000Z",
      preservation_method: "coravin",
      theoretical_remaining_ml: 515,
    });
    const second = row({
      wine_id: "wine-2",
      opened_at: "2026-08-19T10:00:00.000Z",
      preservation_method: "vacuum",
      theoretical_remaining_ml: 420,
    });

    await renderDrawer(root, first);
    await change(select("Preservation method"), "argon");
    await change(input("actual_remaining_ml"), "111");

    await renderDrawer(root, second);

    expect(select("Preservation method").value).toBe("vacuum");
    expect(input("actual_remaining_ml").value).toBe("420");

    await click(button("Open bottle"));
    await click(button("Close bottle"));

    expect(requests).toEqual([
      { wine_id: "wine-2", preservation_method: "vacuum" },
      {
        wine_id: "wine-2",
        actual_remaining_ml: 420,
        written_off_ml: 0,
      },
    ]);

    await act(async () => root.unmount());
  });

  it("also changes the remount key for a replacement bottle of the same wine", () => {
    const first = row({ wine_id: "wine-1", opened_at: "2026-08-18T10:00:00.000Z" });
    const replacement = row({ wine_id: "wine-1", opened_at: "2026-08-19T10:00:00.000Z" });

    expect(drawerStateKey(first)).not.toBe(drawerStateKey(replacement));
  });
});

async function renderDrawer(root: ReturnType<typeof createRoot>, value: CellarWineRow) {
  await act(async () => {
    root.render(
      <ToastProvider>
        <WineDetailDrawer
          key={drawerStateKey(value)}
          row={value}
          canManage
          onClose={() => undefined}
        />
      </ToastProvider>,
    );
  });
}

async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLButtonElement) {
  await act(async () => {
    element.click();
  });
}

function select(label: string) {
  return document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
}

function input(name: string) {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text)!;
}

function row(overrides: Partial<CellarWineRow>): CellarWineRow {
  return {
    wine_id: "wine-1",
    name: "Test Wine",
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
    open_remaining_ml: 500,
    opened_at: "2026-08-18T10:00:00.000Z",
    open_bottle_id: "bottle-1",
    preservation_method: "coravin",
    opened_by: null,
    theoretical_remaining_ml: 515,
    closeout_reason_codes: [],
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
