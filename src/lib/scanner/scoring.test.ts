/**
 * Unit tests for `scoreItems` (BND-011).
 *
 * Pure function, no mocks. Covers every branch of the fallback-reason
 * decision tree plus the rounding + empty-list edge cases.
 */
import { describe, it, expect } from "vitest";
import { scoreItems } from "./scoring";
import type { LineItem } from "./types";

function item(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: "x",
    name: "n",
    producer: "p",
    vintage: 2020,
    varietal: "v",
    region: "r",
    qty: 1,
    unitCost: 10,
    confidence: 0.95,
    ...overrides,
  };
}

describe("scoreItems", () => {
  it("returns a clean pass when items are plentiful and confident", () => {
    const q = scoreItems([
      item({ id: "a", confidence: 0.95 }),
      item({ id: "b", confidence: 0.92 }),
      item({ id: "c", confidence: 0.93 }),
    ]);
    expect(q).toEqual({
      avgConfidence: 0.933,
      lowConfidenceItems: 0,
      totalItems: 3,
      manualFallbackTriggered: false,
      reason: undefined,
    });
  });

  it("flags `too_few_items` when the list has fewer than 3 items", () => {
    const q = scoreItems([
      item({ id: "a", confidence: 0.95 }),
      item({ id: "b", confidence: 0.95 }),
    ]);
    expect(q.manualFallbackTriggered).toBe(true);
    expect(q.reason).toBe("too_few_items");
    expect(q.totalItems).toBe(2);
  });

  it("flags `low_confidence` when the average drops below 0.9 despite 3+ items", () => {
    const q = scoreItems([
      item({ id: "a", confidence: 0.8 }),
      item({ id: "b", confidence: 0.85 }),
      item({ id: "c", confidence: 0.88 }),
    ]);
    // avg = 0.843, <0.9
    expect(q.avgConfidence).toBeCloseTo(0.843, 3);
    expect(q.manualFallbackTriggered).toBe(true);
    expect(q.reason).toBe("low_confidence");
  });

  it("flags `both` when the list is small AND the average is low", () => {
    const q = scoreItems([
      item({ id: "a", confidence: 0.6 }),
      item({ id: "b", confidence: 0.55 }),
    ]);
    expect(q.manualFallbackTriggered).toBe(true);
    expect(q.reason).toBe("both");
  });

  it("counts items below 0.75 as low-confidence items", () => {
    const q = scoreItems([
      item({ id: "a", confidence: 0.95 }),
      item({ id: "b", confidence: 0.74 }),
      item({ id: "c", confidence: 0.5 }),
      item({ id: "d", confidence: 0.91 }),
    ]);
    // Two below 0.75 (0.74 and 0.5).
    expect(q.lowConfidenceItems).toBe(2);
  });

  it("returns zeros and a `both` fallback for an empty list (0 items AND avg=0)", () => {
    // Both thresholds trip: avg 0 < 0.9 (lowConf) AND totalItems 0 < 3 (tooFew).
    const q = scoreItems([]);
    expect(q).toEqual({
      avgConfidence: 0,
      lowConfidenceItems: 0,
      totalItems: 0,
      manualFallbackTriggered: true,
      reason: "both",
    });
  });

  it("does NOT trip fallback at exactly the boundary (avg 0.9, 3 items)", () => {
    // 0.9 is NOT <0.9, so lowConf stays false.
    const q = scoreItems([
      item({ id: "a", confidence: 0.9 }),
      item({ id: "b", confidence: 0.9 }),
      item({ id: "c", confidence: 0.9 }),
    ]);
    expect(q.avgConfidence).toBe(0.9);
    expect(q.manualFallbackTriggered).toBe(false);
    expect(q.reason).toBeUndefined();
  });

  it("rounds avgConfidence to 3 decimal places", () => {
    const q = scoreItems([
      item({ id: "a", confidence: 0.123456 }),
      item({ id: "b", confidence: 0.654321 }),
      item({ id: "c", confidence: 0.987654 }),
    ]);
    // raw = (0.123456 + 0.654321 + 0.987654) / 3 = 0.588477 → 0.588
    expect(q.avgConfidence).toBe(0.588);
  });
});
