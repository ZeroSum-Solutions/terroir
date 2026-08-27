import { describe, expect, it } from "vitest";
import { lookupCountry, normalizeCountryText, UNMATCHED } from "./country-lookup";
import { WORLD_COUNTRY_PATHS } from "./world-paths.generated";

describe("normalizeCountryText", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeCountryText("  United   States  ")).toBe("united states");
  });

  it("strips diacritics", () => {
    expect(normalizeCountryText("México")).toBe("mexico");
  });

  it("strips periods so U.S.A. matches USA", () => {
    expect(normalizeCountryText("U.S.A.")).toBe("usa");
  });
});

describe("lookupCountry", () => {
  it("matches an exact world-atlas display name", () => {
    expect(lookupCountry("France")).toBe("250");
    expect(WORLD_COUNTRY_PATHS["250"].name).toBe("France");
  });

  it("is case- and whitespace-insensitive against the atlas name", () => {
    expect(lookupCountry("  france ")).toBe("250");
    expect(lookupCountry("FRANCE")).toBe("250");
  });

  it("resolves common wine-country aliases to the same key", () => {
    for (const alias of ["USA", "United States", "U.S.", "U.S.A.", "united states of america"]) {
      expect(lookupCountry(alias)).toBe("840");
    }
    for (const alias of ["UK", "England", "United Kingdom", "Great Britain"]) {
      expect(lookupCountry(alias)).toBe("826");
    }
  });

  it("returns UNMATCHED for an unresolvable label instead of guessing", () => {
    expect(lookupCountry("Wineland")).toBe(UNMATCHED);
  });

  it("returns UNMATCHED for an empty or blank label", () => {
    expect(lookupCountry("")).toBe(UNMATCHED);
    expect(lookupCountry("   ")).toBe(UNMATCHED);
  });
});
