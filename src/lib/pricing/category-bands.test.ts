import { describe, expect, it } from "vitest";
import {
  getCategoryBand,
  getCategoryMidpointMarkup,
  getCategoryMidpointPourCost,
} from "./category-bands";

describe("getCategoryBand", () => {
  it("returns Champagne band for region match", () => {
    const band = getCategoryBand({ region: "Champagne", varietal: "Champagne Blend" });
    expect(band?.label).toBe("Champagne");
    expect(band?.markupLow).toBe(1.8);
    expect(band?.markupHigh).toBe(2.5);
  });

  it("returns Burgundy band (region) over generic Pinot Noir varietal", () => {
    // Burgundy region rule comes before generic pinot noir in lookup order
    const band = getCategoryBand({ varietal: "Pinot Noir", region: "Burgundy" });
    expect(band?.label).toBe("Burgundy");
  });

  it("returns Bordeaux 1ère for Bordeaux region with rating ≥ 95", () => {
    const band = getCategoryBand({ region: "Pauillac, Bordeaux", rating: 95 });
    expect(band?.label).toBe("Bordeaux 1ère");
    expect(band?.markupHigh).toBe(2.6);
  });

  it("returns generic Bordeaux for Bordeaux region without high critic score", () => {
    const band = getCategoryBand({ region: "Bordeaux", rating: 88 });
    expect(band?.label).toBe("Bordeaux");
    expect(band?.markupHigh).toBe(3.2);
  });

  it("returns Piedmont for Barolo wines", () => {
    const band = getCategoryBand({ varietal: "Nebbiolo", region: "Piedmont" });
    expect(band?.label).toBe("Piedmont");
  });

  it("returns Super Tuscan band for Tuscany ≥95 pts", () => {
    const band = getCategoryBand({ region: "Tuscany", rating: 96 });
    expect(band?.label).toBe("Super Tuscan / icon");
  });

  it("returns null for varieties with no rule (Salon NV scenario)", () => {
    // Salon Le Mesnil is Champagne — caught by Champagne region/varietal
    // Truly obscure (Txakoli) returns null
    const band = getCategoryBand({ varietal: "Txakoli", region: "Basque Country" });
    expect(band).toBeNull();
  });

  it("returns generic varietal fallback when no region match", () => {
    const band = getCategoryBand({ varietal: "Cabernet Sauvignon", region: "Sonoma" });
    expect(band?.label).toBe("Cabernet Sauvignon");
    expect(band?.markupLow).toBe(3.0);
  });

  it("does not flag a Salon NV against generic 2.5× (architect finding 4 — Champagne band wins)", () => {
    const band = getCategoryBand({ varietal: "Champagne", region: "Champagne" });
    expect(band?.markupLow).toBe(1.8);
    expect(band?.markupHigh).toBe(2.5);
    // A 2.0× actual markup falls within 1.8-2.5 — would NOT be flagged outlier
  });

  it("handles case-insensitive matching", () => {
    const band = getCategoryBand({ varietal: "PINOT NOIR", region: "BURGUNDY" });
    expect(band?.label).toBe("Burgundy");
  });

  it("returns null on missing inputs", () => {
    expect(getCategoryBand({})).toBeNull();
    expect(getCategoryBand({ varietal: null, region: null })).toBeNull();
  });
});

describe("getCategoryMidpointMarkup", () => {
  it("returns midpoint for Champagne (1.8 + 2.5) / 2", () => {
    expect(getCategoryMidpointMarkup({ region: "Champagne" })).toBe(2.15);
  });

  it("returns null when no category matches", () => {
    expect(getCategoryMidpointMarkup({ varietal: "Txakoli" })).toBeNull();
  });
});

describe("getCategoryMidpointPourCost", () => {
  it("returns midpoint for Champagne pour-cost band", () => {
    expect(getCategoryMidpointPourCost({ region: "Champagne" })).toBe(27);
  });

  it("returns null when no category matches", () => {
    expect(getCategoryMidpointPourCost({ varietal: "Txakoli" })).toBeNull();
  });
});
