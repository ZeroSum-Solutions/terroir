import { describe, expect, it } from "vitest";
import { summarizeCellarHealth, summarizeUnscoredStock } from "./summary";

describe("summarizeCellarHealth", () => {
  it("computes stocked-wine count and value for every segment", () => {
    const summary = summarizeCellarHealth(
      [
        { wine_id: "window", segment: "window_risk" },
        { wine_id: "dead", segment: "dead_stock" },
        { wine_id: "stale-row", segment: "cash_trap" },
        { wine_id: "zero-cost", segment: "healthy" },
      ],
      [
        { wine_id: "window", quantity: 2, unit_cost: 50 },
        { wine_id: "window", quantity: 1, unit_cost: 75 },
        { wine_id: "dead", quantity: 3, unit_cost: 25 },
        { wine_id: "stale-row", quantity: 0, unit_cost: 900 },
        { wine_id: "zero-cost", quantity: 2, unit_cost: 0 },
      ],
    );

    expect(summary).toEqual([
      { segment: "window_risk", count: 1, value: 175 },
      { segment: "hold", count: 0, value: 0 },
      { segment: "dead_stock", count: 1, value: 75 },
      { segment: "cash_trap", count: 0, value: 0 },
      { segment: "healthy", count: 1, value: 0 },
    ]);
  });
});

describe("summarizeUnscoredStock", () => {
  it("counts stocked wines that have no valid cellar_health segment", () => {
    const unscored = summarizeUnscoredStock(
      [
        { wine_id: "scored", segment: "healthy" },
        { wine_id: "bad-segment", segment: "not-a-segment" },
      ],
      [
        { wine_id: "scored", quantity: 2, unit_cost: 50 },
        { wine_id: "bad-segment", quantity: 1, unit_cost: 80 },
        { wine_id: "never-scored", quantity: 3, unit_cost: 40 },
        { wine_id: "no-stock", quantity: 0, unit_cost: 900 },
      ],
    );

    // bad-segment ($80) + never-scored ($120); scored and zero-stock excluded.
    expect(unscored).toEqual({ count: 2, value: 200 });
  });

  it("returns zeros when every stocked wine is scored", () => {
    expect(
      summarizeUnscoredStock(
        [{ wine_id: "a", segment: "healthy" }],
        [{ wine_id: "a", quantity: 1, unit_cost: 10 }],
      ),
    ).toEqual({ count: 0, value: 0 });
  });
});
