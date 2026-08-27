import { describe, it, expect } from "vitest";
import { buildLwinQueryVariants } from "./lwin-matching";

describe("buildLwinQueryVariants", () => {
  it("returns exactly the one classic query for rows with a real producer", () => {
    expect(buildLwinQueryVariants("Domaine A", "Richebourg Grand Cru")).toEqual([
      { producer: "Domaine A", name: "Richebourg Grand Cru" },
    ]);
  });

  it("returns only the full-name query for a producer-less 2-token name", () => {
    expect(buildLwinQueryVariants("", "La Pianelle")).toEqual([
      { producer: "La Pianelle", name: "La Pianelle" },
    ]);
  });

  it("adds a first-2-token producer variant at 3 tokens", () => {
    expect(buildLwinQueryVariants("", "Vietti Barolo Lazzarito")).toEqual([
      { producer: "Vietti Barolo Lazzarito", name: "Vietti Barolo Lazzarito" },
      { producer: "Vietti Barolo", name: "Vietti Barolo Lazzarito" },
    ]);
  });

  it("adds first-2 and first-3 token producer variants at 4+ tokens", () => {
    expect(
      buildLwinQueryVariants("", "Poggio di Sotto Brunello di Montalcino"),
    ).toEqual([
      {
        producer: "Poggio di Sotto Brunello di Montalcino",
        name: "Poggio di Sotto Brunello di Montalcino",
      },
      {
        producer: "Poggio di",
        name: "Poggio di Sotto Brunello di Montalcino",
      },
      {
        producer: "Poggio di Sotto",
        name: "Poggio di Sotto Brunello di Montalcino",
      },
    ]);
  });

  it("token-splits on runs of whitespace without empty tokens", () => {
    expect(buildLwinQueryVariants("", "  Le  Ragnaie   Brunello  ")).toEqual([
      { producer: "  Le  Ragnaie   Brunello  ", name: "  Le  Ragnaie   Brunello  " },
      { producer: "Le Ragnaie", name: "  Le  Ragnaie   Brunello  " },
    ]);
  });
});
