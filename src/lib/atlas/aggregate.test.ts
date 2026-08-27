import { describe, expect, it } from "vitest";
import { facetCounts, type CellarFacetRow } from "@/lib/cellar-facets";
import { aggregateAtlasCountries, regionsForCountry } from "./aggregate";

function wine(overrides: Partial<CellarFacetRow> = {}): CellarFacetRow {
  return {
    wine_id: "wine-1",
    producer: "Alpha Estate",
    region: "Napa",
    country: "USA",
    varietal: "Cabernet Sauvignon",
    vintage: 2018,
    wine_size_ml: 750,
    sealed_count: 3,
    healthSegment: "healthy",
    ...overrides,
  };
}

const rows: CellarFacetRow[] = [
  wine({ wine_id: "w1", country: "USA", region: "Napa", sealed_count: 3 }),
  wine({ wine_id: "w2", country: "United States", region: "Sonoma", sealed_count: 2 }),
  wine({ wine_id: "w3", country: "France", region: "Burgundy", sealed_count: 6 }),
  wine({ wine_id: "w4", country: "France", region: null, sealed_count: 1 }),
  wine({ wine_id: "w5", country: "Wineland", region: "Nowhere", sealed_count: 4 }),
  wine({ wine_id: "w6", country: null, region: null, sealed_count: 5 }),
];

describe("aggregateAtlasCountries", () => {
  it("merges alias spellings of the same country under one key", () => {
    const { countries } = aggregateAtlasCountries(rows);
    const usa = countries.find((c) => c.key === "840");
    expect(usa).toBeDefined();
    expect(usa!.label).toBe("United States of America");
    expect(usa!.rawLabels.sort()).toEqual(["USA", "United States"]);
    expect(usa!.bottles).toBe(5); // 3 + 2
    expect(usa!.wines).toBe(2);
  });

  it("surfaces an unresolvable label in unmatched, never dropping it", () => {
    const { unmatched } = aggregateAtlasCountries(rows);
    expect(unmatched).toEqual([{ label: "Wineland", bottles: 4, wines: 1 }]);
  });

  it("excludes rows with no country recorded from both lists", () => {
    const { countries, unmatched } = aggregateAtlasCountries(rows);
    const totalCountryRows = countries.reduce((n, c) => n + c.wines, 0);
    const totalUnmatchedRows = unmatched.reduce((n, u) => n + u.wines, 0);
    // 6 rows total, 1 has a null country -> 5 should be accounted for.
    expect(totalCountryRows + totalUnmatchedRows).toBe(5);
  });

  it("bottle totals match a direct sealed_count sum per resolved key (truth check)", () => {
    const { countries } = aggregateAtlasCountries(rows);
    const france = countries.find((c) => c.key === "250")!;
    const expectedFranceBottles = rows
      .filter((r) => r.country === "France")
      .reduce((sum, r) => sum + r.sealed_count, 0);
    expect(france.bottles).toBe(expectedFranceBottles);
  });

  it("returns empty lists for a cellar with no country data", () => {
    const noCountryRows = [wine({ wine_id: "w1", country: null })];
    expect(aggregateAtlasCountries(noCountryRows)).toEqual({ countries: [], unmatched: [] });
  });
});

describe("regionsForCountry", () => {
  it("matches facetCounts' own country-scoped region truth for a single spelling", () => {
    const expected = facetCounts(rows, { country: "France" }).region;
    expect(regionsForCountry(rows, ["France"])).toEqual(expected);
  });

  it("merges region counts across multiple raw spellings of the same country", () => {
    const result = regionsForCountry(rows, ["USA", "United States"]);
    const napa = result.find((r) => r.label === "Napa");
    const sonoma = result.find((r) => r.label === "Sonoma");
    expect(napa?.count).toBe(1);
    expect(sonoma?.count).toBe(1);
  });

  it("includes the Unknown bucket for a country whose rows have no region", () => {
    const result = regionsForCountry(rows, ["France"]);
    const unknown = result.find((r) => r.isUnknown);
    expect(unknown).toBeDefined();
    expect(unknown?.count).toBe(1); // w4
  });
});
