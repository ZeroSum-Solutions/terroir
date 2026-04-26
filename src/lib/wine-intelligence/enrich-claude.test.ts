import { describe, expect, it } from "vitest";
import { __validateForTests } from "./enrich-claude";

// We test the validator exhaustively here so the unit test catches
// any drift in Claude's response shape before it reaches production.
// Network calls are intentionally NOT tested — they'd require mocking
// the Anthropic SDK and the value would be low (we'd just be testing
// the SDK itself).

describe("Claude enrichment validator", () => {
  it("accepts all-null response (the too-obscure-to-estimate branch)", () => {
    expect(
      __validateForTests({
        drinkWindowStart: null,
        drinkWindowEnd: null,
        peakYear: null,
        reviewExcerpt: null,
      }),
    ).toBe(true);
  });

  it("accepts a well-formed full response", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2035,
        peakYear: 2027,
        reviewExcerpt: "Should drink beautifully through 2035.",
      }),
    ).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(__validateForTests({})).toBe(false);
    expect(__validateForTests({ drinkWindowStart: 2020 })).toBe(false);
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2030,
      }),
    ).toBe(false);
  });

  it("rejects non-integer years", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2020.5,
        drinkWindowEnd: 2030,
        peakYear: 2025,
        reviewExcerpt: null,
      }),
    ).toBe(false);
  });

  it("rejects out-of-range years", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 1850,
        drinkWindowEnd: 2030,
        peakYear: null,
        reviewExcerpt: null,
      }),
    ).toBe(false);
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2200,
        peakYear: null,
        reviewExcerpt: null,
      }),
    ).toBe(false);
  });

  it("rejects start > end", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2030,
        drinkWindowEnd: 2020,
        peakYear: null,
        reviewExcerpt: null,
      }),
    ).toBe(false);
  });

  it("rejects peak outside window", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2030,
        peakYear: 2040,
        reviewExcerpt: null,
      }),
    ).toBe(false);
  });

  it("rejects review excerpt > 240 chars", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2030,
        peakYear: 2025,
        reviewExcerpt: "x".repeat(241),
      }),
    ).toBe(false);
  });

  it("accepts review excerpt at exactly 240 chars", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2030,
        peakYear: 2025,
        reviewExcerpt: "x".repeat(240),
      }),
    ).toBe(true);
  });

  it("rejects null/array/string responses (must be plain object)", () => {
    expect(__validateForTests(null)).toBe(false);
    expect(__validateForTests([])).toBe(false);
    expect(__validateForTests("not an object")).toBe(false);
  });

  it("accepts null peak with valid window", () => {
    expect(
      __validateForTests({
        drinkWindowStart: 2020,
        drinkWindowEnd: 2030,
        peakYear: null,
        reviewExcerpt: "Drink anytime.",
      }),
    ).toBe(true);
  });
});
