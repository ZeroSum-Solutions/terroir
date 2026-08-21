import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";
import type { CellarWineRow } from "./types";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { drawerStateKey, WineDetailDrawer } = await import("./wine-detail-drawer");

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

describe("WineDetailDrawer bottle state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    refresh.mockClear();
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

  it("pauses the drawer trap while the nested 86 dialog owns and restores focus", async () => {
    const outerTrigger = document.createElement("button");
    outerTrigger.textContent = "Open wine";
    document.body.append(outerTrigger);
    outerTrigger.focus();
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Harness() {
      const [current, setCurrent] = useState<CellarWineRow | null>(row({}));
      return (
        <ToastProvider>
          <WineDetailDrawer
            row={current}
            canManage
            onClose={() => {
              setCurrent(null);
              onClose();
            }}
          />
        </ToastProvider>
      );
    }

    await act(async () => root.render(<Harness />));
    await flushFocusFrame();
    const outerDialog = dialogByTitle(container, "Test Wine")!;
    const nestedTrigger = button(outerDialog, "86 this wine");
    nestedTrigger.focus();
    await click(nestedTrigger);

    const childDialog = dialogByTitle(container, "86 wine")!;
    await flushFocusFrame();
    const textarea = childDialog.querySelector<HTMLTextAreaElement>("textarea")!;
    const childConfirm = button(childDialog, "86 Test Wine");
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(outerTrigger);

    childConfirm.focus();
    pressTab();
    expect(document.activeElement).toBe(textarea);
    textarea.focus();
    pressTab(true);
    expect(document.activeElement).toBe(childConfirm);

    await click(button(childDialog, "Cancel"));
    expect(document.activeElement).toBe(nestedTrigger);

    const outerControls = [...outerDialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    const first = outerControls[0];
    const last = outerControls.at(-1)!;
    last.focus();
    pressTab();
    expect(document.activeElement).toBe(first);
    first.focus();
    pressTab(true);
    expect(document.activeElement).toBe(last);

    await click(outerDialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(outerTrigger);
    await act(async () => root.unmount());
  });

  it("keeps the 86 target and audit note after failure, then retries the same payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Availability update failed." }, 500))
      .mockResolvedValueOnce(jsonResponse({}, 200));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await renderDrawer(root, row({ wine_id: "wine-86" }));

    await click(button(container, "86 this wine"));
    let dialog = dialogByTitle(container, "86 wine")!;
    await changeTextarea(dialog.querySelector<HTMLTextAreaElement>("textarea")!, "  Sold out  ");
    await click(button(dialog, "86 Test Wine"));

    dialog = dialogByTitle(container, "86 wine")!;
    expect(dialog).toBeDefined();
    expect(dialog.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("  Sold out  ");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Availability update failed.",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/wines/wine-86/availability", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "eightysixed", note: "Sold out" }),
    });

    await click(button(dialog, "86 Test Wine"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/wines/wine-86/availability", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "eightysixed", note: "Sold out" }),
    });
    expect(dialogByTitle(container, "86 wine")).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("submits the restore direction through the shared confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 200));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await renderDrawer(root, row({ wine_id: "wine-restore", is_eightysixed: true }));

    await click(button(container, "Restore"));
    const dialog = dialogByTitle(container, "Restore wine")!;
    await click(button(dialog, "Restore Test Wine"));
    expect(fetchMock).toHaveBeenCalledWith("/api/wines/wine-restore/availability", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "restored", note: undefined }),
    });
    expect(dialogByTitle(container, "Restore wine")).toBeUndefined();
    await act(async () => root.unmount());
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

async function changeTextarea(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
      .set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function dialogByTitle(root: ParentNode, title: string) {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => {
    const heading = dialog.querySelector("h2");
    return heading?.textContent?.includes(title);
  });
}

function pressTab(shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
}

async function flushFocusFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function select(label: string) {
  return document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
}

function input(name: string) {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

function button(rootOrText: ParentNode | string, maybeText?: string) {
  const root = typeof rootOrText === "string" ? document : rootOrText;
  const text = typeof rootOrText === "string" ? rootOrText : maybeText;
  return [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text)!;
}

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
    open_remaining_ml: 500,
    opened_at: "2026-08-18T10:00:00.000Z",
    open_bottle_id: "bottle-1",
    preservation_method: "coravin",
    opened_by: null,
    theoretical_remaining_ml: 515,
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
