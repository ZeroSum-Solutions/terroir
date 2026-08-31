import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PricingAlertRow } from "@/lib/pricing/alerts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { PricingReviewCard } = await import("./pricing-review-card");

/**
 * SD-26 — the snooze control was `h-[30px] w-[30px]`, the only control in the
 * app deliberately under the 44px floor, and the one that dismisses a pricing
 * alert for 30 days.
 *
 * This is asserted here rather than in `e2e/one-row-rule.test.ts` because the
 * card cannot be reached in a browser on this checkout: `fetchPricingAlerts`
 * builds a PostgREST `wine_id=in.(…)` filter from every wine with a retail
 * median, which on the 250-wine seed is a 9,027-character URL — the request
 * comes back **414 URI Too Long**, `/api/insights/pricing-review` 500s, and
 * `insights/page.tsx` swallows it with `.catch(() => [])`, so the card renders
 * for zero alerts and never mounts. That is a real defect and a separate one;
 * it is recorded rather than fixed here.
 *
 * Same idiom as refresh-actions.mobile.test.tsx.
 */
describe("PricingReviewCard snooze target", () => {
  it("gives snooze the same 44px floor as every other control in the row", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PricingReviewCard alerts={[alert()]} canManage />,
    );

    const snooze = document.querySelector<HTMLElement>(
      '[aria-label="Snooze 30 days"]',
    )!;
    expect(snooze).not.toBeNull();
    expect(snooze.className).toContain("min-h-11");
    expect(snooze.className).toContain("min-w-11");
    expect(snooze.className).not.toContain("h-[30px]");
  });
});

function alert(): PricingAlertRow {
  return {
    wine_id: "wine-1",
    wine_list_item_id: "item-1",
    name: "Chablis",
    producer: "William Fèvre",
    vintage: 2021,
    varietal: "Chardonnay",
    region: "Burgundy",
    bottle_price: 40,
    glass_price: 14,
    glass_pour_ml: 148,
    size_ml: 750,
    retail_median: 85,
    unit_cost: 30,
    bottleStatus: "outlier",
    glassStatus: "on_target",
    targetPourCostPct: 22,
    targetMarkupRatio: 2.7,
    pourCostPct: 42,
    markupRatio: 0.47,
  };
}
