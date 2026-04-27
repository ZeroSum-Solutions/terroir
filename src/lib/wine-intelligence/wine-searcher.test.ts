import { describe, expect, it } from "vitest";
import { __parseForTests } from "./wine-searcher";

// Network-touching code (fetchRetailPrices) is intentionally NOT tested
// here — we'd be testing the fetch wrapper, not our logic. Schema validation
// + parsing is exhaustively unit-tested instead. End-to-end happens via
// manual smoke against real wines (per BND-040 plan §Verification).

describe("Wine-Searcher response parser", () => {
  it("parses a typical trade-API response (top-level fields)", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      offers_count: 142,
    });
    expect(result?.retailMin).toBe(80);
    expect(result?.retailMax).toBe(110);
    expect(result?.retailMedian).toBe(92);
    expect(result?.retailerCount).toBe(142);
  });

  it("parses a wine-wrapped response variant", () => {
    const result = __parseForTests({
      wine: {
        priceMin: 80,
        priceMax: 110,
        priceAvg: 92,
        merchant_count: 142,
      },
    });
    expect(result?.retailMin).toBe(80);
    expect(result?.retailMax).toBe(110);
  });

  it("accepts string numbers (some Wine-Searcher tiers return strings)", () => {
    const result = __parseForTests({
      min_price: "80.00",
      max_price: "110.00",
      average_price: "92.50",
      offers_count: "142",
    });
    expect(result?.retailMedian).toBe(92.5);
  });

  it("rejects non-object body", () => {
    expect(__parseForTests(null)).toBeNull();
    expect(__parseForTests("garbage")).toBeNull();
    expect(__parseForTests(42)).toBeNull();
  });

  it("rejects when required fields missing", () => {
    expect(__parseForTests({ min_price: 80 })).toBeNull();
    expect(__parseForTests({ min_price: 80, max_price: 110 })).toBeNull();
  });

  it("rejects negative prices", () => {
    expect(
      __parseForTests({
        min_price: -5,
        max_price: 110,
        average_price: 92,
        offers_count: 142,
      }),
    ).toBeNull();
  });

  it("rejects when max < min", () => {
    expect(
      __parseForTests({
        min_price: 110,
        max_price: 80,
        average_price: 92,
        offers_count: 142,
      }),
    ).toBeNull();
  });

  it("rejects when median is outside [min, max]", () => {
    expect(
      __parseForTests({
        min_price: 80,
        max_price: 110,
        average_price: 200,
        offers_count: 142,
      }),
    ).toBeNull();
  });

  it("normalizes retailer count to non-negative integer", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      offers_count: -1,
    });
    // -1 is invalid; falls through to 0
    expect(result?.retailerCount).toBe(0);
  });

  it("handles missing retailer count gracefully", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
    });
    expect(result?.retailerCount).toBe(0);
  });

  it("attaches a refresh timestamp", () => {
    const before = Date.now();
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      offers_count: 142,
    });
    const after = Date.now();
    expect(result?.refreshedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result?.refreshedAt.getTime()).toBeLessThanOrEqual(after);
  });
});
