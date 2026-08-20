import { describe, expect, it } from "vitest";
import { summarizeCellarHealth } from "./summary";

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
