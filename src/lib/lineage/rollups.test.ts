/**
 * OPP-1 lineage grouping + rollups (EV-1.1, EV-1.2, EV-1.4).
 *
 * EV-1.4 is a property test: rollups must equal the sum of their children
 * exactly, across randomized cellars. The generator is a seeded LCG so a
 * failure reproduces deterministically from the logged seed.
 */
import { describe, expect, it } from "vitest";
import {
  findDuplicateSuspects,
  groupByLineage,
  type LineageWine,
} from "./rollups";

function makeWine(overrides: Partial<LineageWine> = {}): LineageWine {
  return {
    id: "w-1",
    lineageId: "lin-1",
    producer: "Domaine Jamet",
    name: "Côte-Rôtie",
    vintage: 2019,
    sizeMl: 750,
    quantity: 6,
    value: 1260,
    unitCost: 210,
    ...overrides,
  };
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("groupByLineage", () => {
  it("EV-1.1: groups vintage siblings under one lineage with per-vintage rows intact", () => {
    const w2016 = makeWine({ id: "a", vintage: 2016, quantity: 3, value: 540, unitCost: 180 });
    const w2019 = makeWine({ id: "b", vintage: 2019, quantity: 6, value: 1260, unitCost: 210 });
    const groups = groupByLineage([w2016, w2019]);

    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.wines).toHaveLength(2);
    expect(g.rollup.totalQuantity).toBe(9);
    expect(g.rollup.totalValue).toBe(1800);
    expect(g.rollup.vintageSpan).toEqual([2016, 2019]);
    // EV-1.4 guard: cost basis is never averaged across siblings — each child
    // keeps its own unitCost and the rollup exposes no blended per-bottle cost.
    expect(g.wines.find((w) => w.id === "a")?.unitCost).toBe(180);
    expect(g.wines.find((w) => w.id === "b")?.unitCost).toBe(210);
    expect("unitCost" in g.rollup).toBe(false);
  });

  it("keeps unlinked wines (lineageId null) as singleton groups", () => {
    const linked = makeWine({ id: "a" });
    const orphan1 = makeWine({ id: "b", lineageId: null, name: "Mystery Red" });
    const orphan2 = makeWine({ id: "c", lineageId: null, name: "Mystery White" });
    const groups = groupByLineage([linked, orphan1, orphan2]);
    expect(groups).toHaveLength(3);
    const singletons = groups.filter((g) => g.lineageId === null);
    expect(singletons).toHaveLength(2);
    for (const g of singletons) expect(g.wines).toHaveLength(1);
  });

  it("sorts each lineage's wines by vintage descending, null vintage last", () => {
    const groups = groupByLineage([
      makeWine({ id: "a", vintage: null }),
      makeWine({ id: "b", vintage: 2016 }),
      makeWine({ id: "c", vintage: 2020 }),
    ]);
    expect(groups[0].wines.map((w) => w.id)).toEqual(["c", "b", "a"]);
  });

  it("EV-1.4 (property): rollups equal the exact sum of children across random cellars", () => {
    const seed = 20260819;
    const rand = lcg(seed);
    for (let run = 0; run < 100; run++) {
      const wines: LineageWine[] = [];
      const nLineages = 1 + Math.floor(rand() * 8);
      let id = 0;
      for (let l = 0; l < nLineages; l++) {
        const lineageId = rand() < 0.15 ? null : `lin-${l}`;
        const nWines = 1 + Math.floor(rand() * 5);
        for (let w = 0; w < nWines; w++) {
          wines.push(
            makeWine({
              id: `w-${id++}`,
              lineageId,
              vintage: rand() < 0.1 ? null : 1990 + Math.floor(rand() * 36),
              quantity: Math.floor(rand() * 40),
              value: Math.round(rand() * 10000 * 100) / 100,
              unitCost: rand() < 0.2 ? null : Math.round(rand() * 500 * 100) / 100,
            }),
          );
        }
      }
      const groups = groupByLineage(wines);
      // Every wine lands in exactly one group.
      const seen = groups.flatMap((g) => g.wines.map((w) => w.id)).sort();
      expect(seen, `seed ${seed} run ${run}`).toEqual(wines.map((w) => w.id).sort());
      for (const g of groups) {
        const q = g.wines.reduce((a, w) => a + w.quantity, 0);
        const v = g.wines.reduce((a, w) => a + w.value, 0);
        expect(g.rollup.totalQuantity, `seed ${seed} run ${run}`).toBe(q);
        expect(g.rollup.totalValue, `seed ${seed} run ${run}`).toBeCloseTo(v, 6);
        const vints = g.wines.map((w) => w.vintage).filter((x): x is number => x != null);
        expect(g.rollup.vintageSpan).toEqual(
          vints.length ? [Math.min(...vints), Math.max(...vints)] : null,
        );
      }
    }
  });
});

describe("findDuplicateSuspects", () => {
  it("EV-1.2: flags same lineage + same vintage + same format pairs", () => {
    const a = makeWine({ id: "a", name: "Côte-Rôtie" });
    const b = makeWine({ id: "b", name: "Cote Rotie" }); // spelling variant, same lineage
    const suspects = findDuplicateSuspects([a, b]);
    expect(suspects).toHaveLength(1);
    expect([suspects[0].wineIds[0], suspects[0].wineIds[1]].sort()).toEqual(["a", "b"]);
  });

  it("EV-1.3 precondition: never pairs across vintages or formats or lineages", () => {
    const base = makeWine({ id: "a" });
    const otherVintage = makeWine({ id: "b", vintage: 2016 });
    const otherFormat = makeWine({ id: "c", sizeMl: 1500 });
    const otherLineage = makeWine({ id: "d", lineageId: "lin-2" });
    const unlinked1 = makeWine({ id: "e", lineageId: null });
    const unlinked2 = makeWine({ id: "f", lineageId: null });
    expect(
      findDuplicateSuspects([base, otherVintage, otherFormat, otherLineage, unlinked1, unlinked2]),
    ).toHaveLength(0);
  });

  it("treats null vintage as its own bucket (NV wines can be duplicates of each other)", () => {
    const nv1 = makeWine({ id: "a", vintage: null });
    const nv2 = makeWine({ id: "b", vintage: null });
    const vintaged = makeWine({ id: "c", vintage: 2019 });
    const suspects = findDuplicateSuspects([nv1, nv2, vintaged]);
    expect(suspects).toHaveLength(1);
    expect(suspects[0].wineIds.slice().sort()).toEqual(["a", "b"]);
  });
});
