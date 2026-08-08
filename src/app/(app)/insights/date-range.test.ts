import { describe, expect, it } from "vitest";
import {
  dateRangeSince,
  dateRangeUntil,
  isValidCustomDateRange,
} from "./date-range";

describe("custom insights date range", () => {
  it("uses deterministic UTC day boundaries", () => {
    expect(dateRangeSince("custom", "2026-01-01")?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(dateRangeUntil("custom", "2026-01-31")?.toISOString()).toBe(
      "2026-01-31T23:59:59.999Z",
    );
  });

  it("rejects calendar dates that JavaScript would silently normalize", () => {
    expect(dateRangeSince("custom", "2026-02-31")).toBeNull();
    expect(dateRangeUntil("custom", "2026-02-31")).toBeNull();
  });

  it("rejects partial and reversed custom ranges", () => {
    expect(isValidCustomDateRange("2026-01-01", "2026-01-31")).toBe(true);
    expect(isValidCustomDateRange("2026-01-31", "2026-01-01")).toBe(false);
    expect(isValidCustomDateRange("2026-01-01", undefined)).toBe(false);
  });
});
