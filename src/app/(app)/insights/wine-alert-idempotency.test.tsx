// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PricingAlertRow } from "@/lib/pricing/alerts";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { PricingTargetOverride } = await import(
  "../cellar/pricing-target-override"
);
const { PricingReviewCard } = await import("./pricing-review-card");
const { BriefingAlertCard } = await import("./briefing-alert-card");
const { SnoozedAlertsCard } = await import("./snoozed-alerts-card");
const { OverpaidFlagButton } = await import(
  "@/components/overpaid-flag-button"
);

const WINE_ID = "11111111-1111-4111-8111-111111111111";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function requestKey(index: number): string | null {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key");
}

function requestBody(index: number): unknown {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function button(container: HTMLElement, label: string) {
  const candidate = Array.from(container.querySelectorAll("button")).find(
    (element) =>
      element.textContent?.trim() === label ||
      element.getAttribute("aria-label") === label,
  );
  if (!candidate) throw new Error(`Button ${label} not found`);
  return candidate as HTMLButtonElement;
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const pricingAlert: PricingAlertRow = {
  wine_id: WINE_ID,
  wine_list_item_id: "22222222-2222-4222-8222-222222222222",
  name: "Reserve", producer: "Producer", vintage: 2020,
  varietal: "Cabernet Sauvignon", region: "Napa",
  bottle_price: 120, glass_price: null, glass_pour_ml: null,
  size_ml: 750, retail_median: 40, unit_cost: 30,
  bottleStatus: "outlier", glassStatus: "unknown",
  targetPourCostPct: 22, targetMarkupRatio: 2.7,
  pourCostPct: null, markupRatio: 3,
};

describe("wine alert idempotency callers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  it("guards pricing-target edits and retries a lost response with one key", async () => {
    const first = deferredResponse();
    mockFetch.mockReturnValueOnce(first.promise);
    await act(async () => {
      root.render(
        <PricingTargetOverride
          wineId={WINE_ID}
          perWinePourCostPct={null}
          perWineMarkupRatio={null}
          housePourCostPct={22}
          houseMarkupRatio={2.7}
        />,
      );
    });
    await act(async () => {
      button(container, "Override targets for this wine").click();
    });
    const input = container.querySelector(
      'input[aria-label="Per-wine markup ratio target"]',
    ) as HTMLInputElement;
    await setInput(input, "2.4");

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = requestKey(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(requestBody(0)).toEqual({ markup_ratio: 2.4 });

    await act(async () => {
      first.reject(new TypeError("connection reset after commit"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "connection reset after commit",
      ),
    );

    mockFetch.mockResolvedValueOnce(
      Response.json({
        wineId: WINE_ID,
        pour_cost_pct: null,
        markup_ratio: 2.4,
      }),
    );
    await setInput(input, "2.4");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(requestKey(1)).toBe(originalKey);
    expect(requestBody(1)).toEqual(requestBody(0));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("guards pricing snooze and retains its key across a 503", async () => {
    const first = deferredResponse();
    mockFetch.mockReturnValueOnce(first.promise);
    await act(async () => {
      root.render(
        <PricingReviewCard alerts={[pricingAlert]} firstName="Devin" />,
      );
    });
    const snooze = button(container, "Snooze 30 days");

    await act(async () => {
      snooze.click();
      snooze.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = requestKey(0);

    await act(async () => {
      first.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "temporarily unavailable",
      ),
    );

    mockFetch.mockResolvedValueOnce(
      Response.json({
        wineId: WINE_ID,
        dismissedUntil: "2026-08-23T12:34:56.789Z",
        days: 30,
      }),
    );
    await act(async () => {
      snooze.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(requestKey(1)).toBe(originalKey);
    expect(requestBody(1)).toEqual({ days: 30 });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it("guards drink-window snooze and unsnooze with retry-stable bodies", async () => {
    const snoozeAttempt = deferredResponse();
    mockFetch.mockReturnValueOnce(snoozeAttempt.promise);
    await act(async () => {
      root.render(
        <BriefingAlertCard
          firstName="Devin"
          alert={{
            wine_id: WINE_ID,
            name: "Reserve",
            producer: "Producer",
            vintage: 2020,
            drink_window_start: 2020,
            drink_window_end: 2027,
            peak_year: 2024,
            rating: 95,
            rating_source: "vinous",
            review_excerpt: null,
            bottle_count: 2,
            bin_location: "A-1",
          }}
        />,
      );
    });
    const snooze = button(container, "Snooze 30 days");
    await act(async () => {
      snooze.click();
      snooze.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const snoozeKey = requestKey(0);

    await act(async () => {
      snoozeAttempt.reject(new TypeError("response lost"));
      await Promise.resolve();
      await Promise.resolve();
    });
    mockFetch.mockResolvedValueOnce(
      Response.json({
        wineId: WINE_ID,
        snoozedUntil: "2026-08-24T01:02:03.456Z",
        days: 30,
      }),
    );
    await act(async () => {
      snooze.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(requestKey(1)).toBe(snoozeKey);
    expect(requestBody(1)).toEqual({ days: 30 });

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    const unsnoozeAttempt = deferredResponse();
    mockFetch.mockReturnValueOnce(unsnoozeAttempt.promise);
    await act(async () => {
      root.render(
        <SnoozedAlertsCard
          snoozed={[
            {
              wine_id: WINE_ID,
              name: "Reserve",
              producer: "Producer",
              vintage: 2020,
              drinkWindowSnoozedUntil:
                "2026-08-24T01:02:03.456Z",
              pricingDismissedUntil: null,
            },
          ]}
        />,
      );
    });
    await act(async () => {
      (
        container.querySelector(
          'button[aria-expanded="false"]',
        ) as HTMLButtonElement
      ).click();
    });
    const unsnooze = button(container, "Unsnooze");
    await act(async () => {
      unsnooze.click();
      unsnooze.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    const unsnoozeKey = requestKey(2);
    expect(requestBody(2)).toEqual({ days: 0 });

    await act(async () => {
      unsnoozeAttempt.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    mockFetch.mockResolvedValueOnce(
      Response.json({
        wineId: WINE_ID,
        snoozedUntil: null,
        days: 0,
      }),
    );
    await act(async () => {
      unsnooze.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4));
    expect(requestKey(3)).toBe(unsnoozeKey);
    expect(requestBody(3)).toEqual({ days: 0 });
  });

  it("never double-flips overpaid and advances only after authoritative state", async () => {
    const first = deferredResponse();
    mockFetch.mockReturnValueOnce(first.promise);
    await act(async () => {
      root.render(<OverpaidFlagButton wineId={WINE_ID} flagged={false} />);
    });
    const addFlag = button(container, "Flag as overpaid");
    await act(async () => {
      addFlag.click();
      addFlag.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = requestKey(0);

    await act(async () => {
      root.render(<OverpaidFlagButton wineId={WINE_ID} flagged />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const prematureReverse = button(container, "Remove overpaid flag");
    expect(prematureReverse.disabled).toBe(true);
    prematureReverse.click();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(<OverpaidFlagButton wineId={WINE_ID} flagged={false} />);
      await Promise.resolve();
    });

    await act(async () => {
      first.reject(new TypeError("connection reset after commit"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "connection reset after commit",
      ),
    );

    mockFetch.mockResolvedValueOnce(
      Response.json({ wineId: WINE_ID, overpaid_flag: true }),
    );
    await act(async () => {
      addFlag.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(requestKey(1)).toBe(originalKey);

    await act(async () => {
      root.render(<OverpaidFlagButton wineId={WINE_ID} flagged />);
      await Promise.resolve();
    });
    await act(
      async () =>
        await new Promise((resolve) => setTimeout(resolve, 0)),
    );
    const removeFlag = button(container, "Remove overpaid flag");
    mockFetch.mockResolvedValueOnce(
      Response.json({ wineId: WINE_ID, overpaid_flag: false }),
    );
    await act(async () => {
      removeFlag.click();
      removeFlag.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(requestKey(2)).not.toBe(originalKey);
  });
});
