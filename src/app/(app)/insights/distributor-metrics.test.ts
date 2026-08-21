import { describe, expect, it } from "vitest";
import {
  distributorSpendShare,
  summarizeDistributorMetrics,
} from "./distributor-metrics";

describe("summarizeDistributorMetrics", () => {
  it("derives scan count and spend from the same scans", () => {
    expect(
      summarizeDistributorMetrics([
        {
          distributor_name: "Estate Imports",
          final_line_items: [
            { qty: 2, unitCost: 18.5 },
            { qty: 1, unitCost: 40 },
          ],
        },
        {
          distributor_name: "Estate Imports",
          final_line_items: [{ qty: 3, unitCost: 12 }],
        },
        {
          distributor_name: "Other",
          final_line_items: null,
        },
      ]),
    ).toEqual([
      { name: "Estate Imports", scans: 2, spend: 113 },
      { name: "Other", scans: 1, spend: 0 },
    ]);
  });

  it("ignores malformed, negative, and missing line item values when calculating spend", () => {
    expect(
      summarizeDistributorMetrics([
        {
          distributor_name: "Estate Imports",
          final_line_items: [
            { qty: 2, unitCost: 10 },
            { qty: "3", unitCost: 10 },
            { qty: -1, unitCost: 10 },
            { qty: 2, unitCost: -10 },
            { qty: Infinity, unitCost: 10 },
            { qty: 2, unitCost: undefined },
            {},
          ],
        },
      ]),
    ).toEqual([{ name: "Estate Imports", scans: 1, spend: 20 }]);
  });
});

describe("distributorSpendShare", () => {
  it("returns zero when the total spend is zero", () => {
    expect(distributorSpendShare(0, 0)).toBe(0);
  });

  it("returns the share of positive total spend", () => {
    expect(distributorSpendShare(25, 100)).toBe(0.25);
  });
});
