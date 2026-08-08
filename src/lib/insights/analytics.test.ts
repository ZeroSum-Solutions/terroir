import { describe, expect, it } from "vitest";
import {
  marketPriceShiftPct,
  summarizeLineItemCorrections,
} from "./analytics";

describe("insights extraction accuracy", () => {
  it("counts corrected line items once even when several fields were edited", () => {
    expect(
      summarizeLineItemCorrections([
        {
          item_count: 3,
          edits: {
            "item-a:name": true,
            "item-a:producer": true,
            "item-b:qty": true,
          },
        },
      ]),
    ).toEqual({
      total: 3,
      autoAccepted: 1,
      corrected: 2,
      accuracyPct: 33,
    });
  });

  it("bounds malformed or stale edit keys to the persisted item count", () => {
    expect(
      summarizeLineItemCorrections([
        {
          item_count: 1,
          edits: {
            "item-a:name": true,
            "item-b:name": true,
            malformed: true,
          },
        },
      ]),
    ).toEqual({
      total: 1,
      autoAccepted: 0,
      corrected: 1,
      accuracyPct: 0,
    });
  });
});

describe("market price shift", () => {
  it("compares consecutive market medians instead of purchase cost", () => {
    expect(marketPriceShiftPct(120, 100)).toBeCloseTo(0.2);
    expect(marketPriceShiftPct(80, 100)).toBeCloseTo(-0.2);
  });

  it("does not claim a shift without two positive market observations", () => {
    expect(marketPriceShiftPct(120, null)).toBeNull();
    expect(marketPriceShiftPct(120, 0)).toBeNull();
    expect(marketPriceShiftPct(null, 100)).toBeNull();
  });
});
