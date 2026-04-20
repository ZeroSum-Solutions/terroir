import { describe, expect, it } from "vitest";
import { SCORED_FIELDS, SCORED_FIELDS_COUNT } from "./scored-fields";

describe("SCORED_FIELDS", () => {
  it("contains exactly 7 fields — the denominator used across save-scan, scanner, and results-view", () => {
    expect(SCORED_FIELDS_COUNT).toBe(7);
    expect(SCORED_FIELDS).toHaveLength(7);
  });

  it("has SCORED_FIELDS_COUNT equal to SCORED_FIELDS.length (drift guard)", () => {
    expect(SCORED_FIELDS_COUNT).toBe(SCORED_FIELDS.length);
  });

  it("includes every scored field exactly once (no duplicates)", () => {
    const set = new Set(SCORED_FIELDS);
    expect(set.size).toBe(SCORED_FIELDS.length);
  });
});
