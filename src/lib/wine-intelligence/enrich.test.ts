import { describe, it, expect } from "vitest";
import { enrichWine } from "./enrich";

describe("enrichWine", () => {
  it("returns drink window for cabernet sauvignon with vintage", () => {
    const result = enrichWine({
      varietal: "Cabernet Sauvignon",
      region: "Napa Valley",
      country: "USA",
      vintage: 2020,
    });
    expect(result.drinkWindowStart).toBe(2025); // 2020 + 5
    expect(result.drinkWindowEnd).toBe(2040);   // 2020 + 20
    expect(result.servingTempMin).toBe(60);
    expect(result.servingTempMax).toBe(65);
    expect(result.servingTempLabel).toBe("Cool room temperature");
  });

  it("uses generic varietal rule when region has no specific rule", () => {
    const result = enrichWine({
      varietal: "Cabernet Sauvignon",
      region: "Sonoma",
      country: "USA",
      vintage: 2020,
    });
    // Falls back to generic cabernet: offsetStart 4, offsetEnd 15
    expect(result.drinkWindowStart).toBe(2024);
    expect(result.drinkWindowEnd).toBe(2035);
  });

  it("returns all nulls for unknown varietal with no colour match", () => {
    const result = enrichWine({
      varietal: "Txakoli",
      region: null,
      country: null,
      vintage: 2022,
    });
    expect(result.drinkWindowStart).toBeNull();
    expect(result.servingTempMin).toBeNull();
  });

  it("returns null drink windows when vintage is null", () => {
    const result = enrichWine({
      varietal: "Pinot Noir",
      region: "Burgundy",
      country: "France",
      vintage: null,
    });
    expect(result.drinkWindowStart).toBeNull();
    expect(result.drinkWindowEnd).toBeNull();
    // But serving temp should still be set
    expect(result.servingTempMin).toBe(55);
    expect(result.servingTempMax).toBe(60);
  });

  it("matches colour fallback for unknown red varietal", () => {
    const result = enrichWine({
      varietal: "Cabernet Franc",
      region: null,
      country: null,
      vintage: 2021,
    });
    // cabernet franc is in the reds list → colour "red" fallback
    expect(result.servingTempMin).not.toBeNull();
  });

  it("prefers region-specific rule over generic varietal", () => {
    const napa = enrichWine({
      varietal: "Cabernet Sauvignon",
      region: "Napa",
      country: "USA",
      vintage: 2020,
    });
    const generic = enrichWine({
      varietal: "Cabernet Sauvignon",
      region: "Chile",
      country: "Chile",
      vintage: 2020,
    });
    // Napa rule: offsetEnd 20 vs generic: offsetEnd 15
    expect(napa.drinkWindowEnd).toBeGreaterThan(generic.drinkWindowEnd!);
  });

  it("handles case-insensitive matching", () => {
    const result = enrichWine({
      varietal: "PINOT NOIR",
      region: "BURGUNDY",
      country: "FRANCE",
      vintage: 2020,
    });
    expect(result.drinkWindowStart).toBe(2023);
  });

  // BND-039 additions
  it("returns peakYear at midpoint of drink window when rule matches", () => {
    const result = enrichWine({
      varietal: "Cabernet Sauvignon",
      region: "Napa Valley",
      country: "USA",
      vintage: 2020,
    });
    // Window 2025-2040, peak ≈ 2032 (midpoint, rounded)
    expect(result.peakYear).toBe(Math.round((2025 + 2040) / 2));
  });

  it("returns null peakYear when vintage is null", () => {
    const result = enrichWine({
      varietal: "Pinot Noir",
      region: "Burgundy",
      country: "France",
      vintage: null,
    });
    expect(result.peakYear).toBeNull();
  });

  it("sets ratingSource to 'rule_engine' on a rule match", () => {
    const result = enrichWine({
      varietal: "Cabernet Sauvignon",
      region: "Napa",
      country: "USA",
      vintage: 2020,
    });
    expect(result.ratingSource).toBe("rule_engine");
  });

  it("returns null ratingSource on a rule miss", () => {
    const result = enrichWine({
      varietal: "Txakoli",
      region: null,
      country: null,
      vintage: 2022,
    });
    expect(result.ratingSource).toBeNull();
    expect(result.peakYear).toBeNull();
  });

  it("review excerpt is null from rule engine (only Claude fallback fills this)", () => {
    const result = enrichWine({
      varietal: "Chardonnay",
      region: "Burgundy",
      country: "France",
      vintage: 2020,
    });
    expect(result.reviewExcerpt).toBeNull();
  });
});
