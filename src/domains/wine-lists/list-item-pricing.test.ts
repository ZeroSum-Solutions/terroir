import { describe, expect, it } from "vitest";
import {
  latestUnitCostByWine,
  suggestPricesForWine,
  type PricingWine,
} from "./list-item-pricing";

function wine(overrides: Partial<PricingWine> = {}): PricingWine {
  return {
    id: "wine-1",
    varietal: "Nebbiolo",
    region: "Piedmont",
    rating: null,
    size_ml: 750,
    retail_median: 100,
    pricing_target_markup_ratio: null,
    pricing_target_pour_cost_pct: null,
    ...overrides,
  };
}

describe("suggestPricesForWine", () => {
  it("suggests a bottle price at the house markup when nothing else applies", () => {
    // 2.7× is the built-in fallback in src/lib/pricing/status.ts, reached only
    // when the wine matches no category band either.
    const uncategorised = wine({ varietal: "Zibibbo", region: "Nowhere" });
    expect(
      suggestPricesForWine(uncategorised, null, null, null).suggestedBottle,
    ).toBe(270);
  });

  it("prefers the category band over the house constant", () => {
    // Nebbiolo/Piedmont bands 2.3–3.0×, midpoint 2.65.
    expect(
      suggestPricesForWine(wine(), null, null, null).suggestedBottle,
    ).toBe(265);
  });

  it("prefers the restaurant's settings markup over the house constant", () => {
    const suggested = suggestPricesForWine(
      wine(),
      { default_target_markup_ratio: 3.5, default_target_pour_cost_pct: null },
      null,
      null,
    );
    expect(suggested.suggestedBottle).toBe(350);
  });

  it("prefers a per-wine override over the restaurant default", () => {
    const suggested = suggestPricesForWine(
      wine({ pricing_target_markup_ratio: 2 }),
      { default_target_markup_ratio: 3.5, default_target_pour_cost_pct: null },
      null,
      null,
    );
    expect(suggested.suggestedBottle).toBe(200);
  });

  it("prices a glass off invoice cost when the restaurant has one", () => {
    // 60 / 750 × 148 = 11.84 per pour; at a 22% target that is $54.
    expect(
      suggestPricesForWine(wine(), null, 60, null).suggestedGlass,
    ).toBe(54);
  });

  it("falls back to retail median for the glass when no invoice cost exists", () => {
    expect(suggestPricesForWine(wine(), null, null, null).suggestedGlass).toBe(
      90,
    );
  });

  it("uses the row's own pour size when one is set", () => {
    const bigger = suggestPricesForWine(wine(), null, 60, 250).suggestedGlass!;
    const standard = suggestPricesForWine(wine(), null, 60, null).suggestedGlass!;
    expect(bigger).toBeGreaterThan(standard);
  });

  // The $7,203-a-glass defect, at the layer the row actually calls.
  //
  // BND-040 finding E: resolvePourCostTarget now treats an implausible
  // stored value (0.24, a fraction where the column means a percent) as
  // absent, the same floor suggestGlassPrice already enforces on its own
  // input — falling through to the house default instead of returning the
  // fraction raw. That keeps this surface and getGlassStatus's deviation
  // math agreeing about what the effective target actually is; it also means
  // the row still gets a usable suggestion (at 22%) instead of a dash.
  it("falls back to the house pour-cost target when the tenant's is a fraction", () => {
    const seeded = { default_target_markup_ratio: 3.2, default_target_pour_cost_pct: 0.24 };
    const suggested = suggestPricesForWine(wine(), seeded, 87.6, null);

    // 87.6/750×148 = 17.29/pour; at the house default 22% that's $79 — not
    // the $7,203 the raw 0.24 would produce, and not a suppressed dash.
    expect(suggested.suggestedGlass).toBe(79);
    // The bottle suggestion is unaffected — only the glass input was bad.
    expect(suggested.suggestedBottle).toBe(320);
  });

  it("suppresses a glass suggestion that lands above the row's own bottle price", () => {
    // Nothing wrong with the target here; the anchor is what makes it absurd.
    const cheapBottle = 12;
    const suggested = suggestPricesForWine(wine(), null, 60, null, cheapBottle);

    expect(suggested.suggestedGlass).toBeNull();
  });

  it("keeps a glass suggestion that sits sensibly under the bottle price", () => {
    expect(suggestPricesForWine(wine(), null, 60, null, 285).suggestedGlass).toBe(54);
  });

  it("returns null — the one case where a dash is correct — with no retail data", () => {
    expect(
      suggestPricesForWine(wine({ retail_median: null }), null, null, null),
    ).toEqual({ suggestedBottle: null, suggestedGlass: null });
  });
});

describe("latestUnitCostByWine", () => {
  it("keeps the first row per wine, the caller having ordered newest-first", () => {
    const costs = latestUnitCostByWine([
      { wine_id: "a", unit_cost: 42 },
      { wine_id: "a", unit_cost: 38 },
      { wine_id: "b", unit_cost: 12 },
    ]);
    expect(costs.get("a")).toBe(42);
    expect(costs.get("b")).toBe(12);
  });

  it("skips rows with no cost rather than recording a zero", () => {
    const costs = latestUnitCostByWine([
      { wine_id: "a", unit_cost: null },
      { wine_id: "a", unit_cost: 38 },
    ]);
    expect(costs.get("a")).toBe(38);
  });
});
