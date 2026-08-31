import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DrinkWindowAlertRow } from "@/lib/drink-window/alerts";
import type { PricingAlertRow } from "@/lib/pricing/alerts";
import type { SnoozedRow } from "@/domains/cellar/snoozed-alerts";
import { BriefingAlertCard } from "./briefing-alert-card";
import { PricingReviewCard } from "./pricing-review-card";
import { SnoozedAlertsCard } from "./snoozed-alerts-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * SD-24 — every snooze/unsnooze control on /insights was rendered and enabled
 * for staff, while `POST /api/wines/{id}/snooze-alert` and
 * `.../dismiss-pricing-alert` are both `requireRole(["owner", "manager"])`.
 * A staff member could press Snooze on any alert and learn it was refused only
 * from the 403 that came back. The server side is unchanged and must stay that
 * way: these lock the affordance to the permission, the same way
 * /reconcile-queue and /bins already do.
 */
const drinkWindowAlert: DrinkWindowAlertRow = {
  wine_id: "wine-1",
  name: "Barolo",
  producer: "Giacomo Conterno",
  vintage: 2016,
  drink_window_start: 2024,
  drink_window_end: 2028,
  peak_year: 2026,
  rating: 97,
  rating_source: "vinous",
  review_excerpt: "Layered and precise.",
  bottle_count: 2,
  bin_location: "A-12",
  hero_image_url: null,
  colour: "red",
};

const pricingAlert: PricingAlertRow = {
  wine_id: "wine-2",
  wine_list_item_id: "item-2",
  name: "Chablis",
  producer: "Domaine Test",
  vintage: 2021,
  varietal: "Chardonnay",
  region: "Burgundy",
  bottle_price: 90,
  glass_price: 18,
  glass_pour_ml: 148,
  size_ml: 750,
  retail_median: 40,
  unit_cost: 30,
  bottleStatus: "outlier",
  glassStatus: "tight",
  targetPourCostPct: 22,
  targetMarkupRatio: 3.2,
  pourCostPct: 34,
  markupRatio: 3,
};

const snoozedRow: SnoozedRow = {
  wine_id: "wine-3",
  name: "Chianti",
  producer: "Fattoria Test",
  vintage: 2020,
  drinkWindowSnoozedUntil: "2099-01-01T00:00:00.000Z",
  pricingDismissedUntil: null,
};

const roots: Root[] = [];
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

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("insights alert cards role affordance", () => {
  it("offers snooze and unsnooze to a manager", async () => {
    expect(
      renderToStaticMarkup(<BriefingAlertCard alert={drinkWindowAlert} canManage />),
    ).toContain("Snooze 30 days");

    expect(
      renderToStaticMarkup(<PricingReviewCard alerts={[pricingAlert]} canManage />),
    ).toContain('aria-label="Snooze 30 days"');

    const expanded = await mountAndExpandSnoozed(true);
    expect(expanded.textContent).toContain("Unsnooze");
  });

  it("offers a staff member no snooze control the API would refuse", async () => {
    const briefing = renderToStaticMarkup(
      <BriefingAlertCard alert={drinkWindowAlert} canManage={false} />,
    );
    expect(briefing).not.toContain("Snooze 30 days");
    // The alert itself stays readable — reading /insights is membership-only.
    expect(briefing).toContain("View 2 bottles");

    const pricing = renderToStaticMarkup(
      <PricingReviewCard alerts={[pricingAlert]} canManage={false} />,
    );
    expect(pricing).not.toContain('aria-label="Snooze 30 days"');
    expect(pricing).toContain("Review");
    expect(pricing).toContain("Chablis");

    const expanded = await mountAndExpandSnoozed(false);
    expect(expanded.textContent).not.toContain("Unsnooze");
    // What is snoozed stays visible — only the control that 403s is gone.
    expect(expanded.textContent).toContain("Chianti");
    expect(expanded.textContent).toContain("Drink-window alert");
  });
});

async function mountAndExpandSnoozed(canManage: boolean): Promise<HTMLElement> {
  const container = await mount(
    <SnoozedAlertsCard snoozed={[snoozedRow]} canManage={canManage} />,
  );
  const expander = container.querySelector<HTMLButtonElement>(
    'button[aria-expanded="false"]',
  );
  if (!expander) throw new Error("Snoozed alerts expander not rendered");
  await act(async () => {
    expander.click();
  });
  return container;
}

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}
