import { describe, expect, it } from "vitest";
import { aggregateCellarInventory } from "./inventory-aggregation";

describe("cellar inventory aggregation", () => {
  it("calculates quantity-weighted cost, latest purchase metadata, and format totals", () => {
    const result = aggregateCellarInventory([
      {
        wine_id: "wine-a",
        bin_location: "Old bin",
        quantity: 1,
        unit_cost: 10,
        added_at: "2026-01-01T00:00:00.000Z",
        section: "Old section",
        format: "750ml",
      },
      {
        wine_id: "wine-a",
        bin_location: "New bin",
        quantity: 3,
        unit_cost: 30,
        added_at: "2026-02-01T00:00:00.000Z",
        section: "New section",
        format: "magnum",
      },
      {
        wine_id: "wine-a",
        bin_location: null,
        quantity: 2,
        unit_cost: 20,
        added_at: "2026-01-15T00:00:00.000Z",
        section: null,
        format: "magnum",
      },
    ]);

    expect(result.get("wine-a")).toEqual({
      sealed: 6,
      bin: "New bin",
      section: "New section",
      averageUnitCost: 140 / 6,
      lastPurchaseAt: "2026-02-01T00:00:00.000Z",
      formats: [
        { format: "750ml", quantity: 1 },
        { format: "magnum", quantity: 5 },
      ],
    });
  });

  it("ignores unrelated rows and does not invent cost or format stock", () => {
    const result = aggregateCellarInventory([
      {
        wine_id: null,
        bin_location: "Foreign",
        quantity: 99,
        unit_cost: 999,
        added_at: "2026-03-01T00:00:00.000Z",
        section: "Foreign",
        format: "magnum",
      },
      {
        wine_id: "wine-b",
        bin_location: null,
        quantity: 0,
        unit_cost: null,
        added_at: null,
        section: null,
        format: null,
      },
    ]);

    expect(result.size).toBe(1);
    expect(result.get("wine-b")).toEqual({
      sealed: 0,
      bin: null,
      section: null,
      averageUnitCost: null,
      lastPurchaseAt: null,
      formats: [],
    });
  });

  it("normalizes a blank positive-stock format to the default bottle", () => {
    const result = aggregateCellarInventory([
      {
        wine_id: "wine-c",
        bin_location: null,
        quantity: 2,
        unit_cost: 12,
        added_at: "2026-04-01T00:00:00.000Z",
        section: null,
        format: "  ",
      },
    ]);

    expect(result.get("wine-c")?.formats).toEqual([
      { format: "750ml", quantity: 2 },
    ]);
  });
});
