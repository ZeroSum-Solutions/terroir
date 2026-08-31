/**
 * OPP-6 bin search and put-away policy (EV-6.2, EV-6.3, EV-6.4).
 */
import { describe, expect, it } from "vitest";
import {
  findBottleMatches,
  suggestPutAway,
  type Bin,
  type BottleInventoryRow,
} from ".";

function row(overrides: Partial<BottleInventoryRow> = {}): BottleInventoryRow {
  return {
    wineId: "wine-1",
    lineageId: "lineage-1",
    name: "Cote Rotie",
    producer: "Domaine Jamet",
    colour: "Red",
    binId: "bin-1",
    binCode: "R1-S1",
    binZone: "Reds",
    quantity: 2,
    ...overrides,
  };
}

function bin(overrides: Partial<Bin> = {}): Bin {
  return {
    id: "bin-1",
    code: "R1-S1",
    zone: "Reds",
    capacity: 12,
    retiredAt: null,
    ...overrides,
  };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("findBottleMatches", () => {
  it("EV-6.2: matches name or producer case-insensitively and sums rows by wine and bin", () => {
    const rows = [
      row({ quantity: 2 }),
      row({ quantity: 4 }),
      row({ wineId: "wine-2", name: "Hermitage", producer: "JAMET", quantity: 3 }),
      row({ wineId: "wine-3", name: "Chablis", producer: "Raveneau", quantity: 9 }),
    ];

    expect(findBottleMatches("jAmEt", rows)).toEqual([
      {
        wineId: "wine-1",
        name: "Cote Rotie",
        producer: "Domaine Jamet",
        colour: "Red",
        heroImageUrl: null,
        binId: "bin-1",
        binCode: "R1-S1",
        binZone: "Reds",
        quantity: 6,
      },
      {
        wineId: "wine-2",
        name: "Hermitage",
        producer: "JAMET",
        colour: "Red",
        heroImageUrl: null,
        binId: "bin-1",
        binCode: "R1-S1",
        binZone: "Reds",
        quantity: 3,
      },
    ]);
    expect(findBottleMatches("ROTIE", rows)).toHaveLength(1);
  });

  it("EV-6.4: omits unplaced stock instead of manufacturing a pseudo-bin", () => {
    const rows = [
      row({ binId: null, binCode: null, binZone: null, quantity: 7 }),
      row({ binId: "bin-2", binCode: "R2-S4", quantity: 2 }),
    ];

    expect(findBottleMatches("Cote", rows)).toEqual([
      expect.objectContaining({ binId: "bin-2", binCode: "R2-S4", quantity: 2 }),
    ]);
  });

  it("omits inconsistent placed rows that have no physical bin code", () => {
    expect(
      findBottleMatches("Cote", [row({ binId: "bin-2", binCode: null })]),
    ).toEqual([]);
  });

  it("returns no matches for a blank query", () => {
    expect(findBottleMatches("  \n", [row()])).toEqual([]);
  });

  it("EV-6.2 invariant: placed totals and groups are independent of row order", () => {
    const seed = 20260819;
    const random = lcg(seed);
    const rows = Array.from({ length: 80 }, (_, index) => {
      const binIndex = Math.floor(random() * 4);
      return row({
        wineId: `wine-${index % 5}`,
        name: `Needle ${index % 5}`,
        binId: binIndex === 3 ? null : `bin-${binIndex}`,
        binCode: binIndex === 3 ? null : `B-${binIndex}`,
        binZone: binIndex === 3 ? null : `Zone ${binIndex % 2}`,
        quantity: 1 + Math.floor(random() * 6),
      });
    });
    const expectedTotal = rows
      .filter((item) => item.binId !== null)
      .reduce((total, item) => total + item.quantity, 0);
    const normalize = (matches: ReturnType<typeof findBottleMatches>) =>
      [...matches].sort((a, b) => `${a.wineId}|${a.binId}`.localeCompare(`${b.wineId}|${b.binId}`));

    const forward = findBottleMatches("needle", rows);
    const reverse = findBottleMatches("needle", [...rows].reverse());

    expect(forward.reduce((total, match) => total + match.quantity, 0), `seed ${seed}`).toBe(
      expectedTotal,
    );
    expect(new Set(forward.map((match) => `${match.wineId}|${match.binId}`)).size).toBe(
      forward.length,
    );
    expect(normalize(forward)).toEqual(normalize(reverse));
  });
});

describe("suggestPutAway", () => {
  it("EV-6.3: returns the first eligible bin already holding the same non-null lineage", () => {
    const bins = [
      bin({ id: "retired", code: "OLD", retiredAt: "2026-08-01T00:00:00Z" }),
      bin({ id: "full", code: "FULL", capacity: 3 }),
      bin({ id: "first", code: "R1-S2" }),
      bin({ id: "second", code: "R1-S3" }),
    ];
    const inventoryRows = [
      row({ binId: "retired" }),
      row({ binId: "full", quantity: 3 }),
      row({ binId: "first" }),
      row({ binId: "second" }),
    ];

    expect(
      suggestPutAway({ wine: { lineageId: "lineage-1", colour: "White" }, inventoryRows, bins }),
    ).toEqual({ binId: "first", code: "R1-S2", zone: "Reds", reason: "same_lineage" });
  });

  it("uses total occupancy from every wine when enforcing capacity", () => {
    const bins = [bin({ id: "bin-1", capacity: 5 }), bin({ id: "bin-2", code: "R1-S2" })];
    const inventoryRows = [
      row({ binId: "bin-1", lineageId: "other", quantity: 4 }),
      row({ binId: "bin-1", quantity: 1 }),
      row({ binId: "bin-2", quantity: 1 }),
    ];

    expect(
      suggestPutAway({ wine: { lineageId: "lineage-1", colour: "Red" }, inventoryRows, bins }),
    ).toEqual({ binId: "bin-2", code: "R1-S2", zone: "Reds", reason: "same_lineage" });
  });

  it("EV-6.3: otherwise chooses the first eligible bin in the strongest same-colour zone", () => {
    const bins = [
      bin({ id: "white-a", code: "W1", zone: "Whites" }),
      bin({ id: "red-a", code: "R1", zone: "Reds" }),
      bin({ id: "red-b", code: "R2", zone: "Reds" }),
      bin({ id: "rose-a", code: "P1", zone: "Rose" }),
    ];
    const inventoryRows = [
      row({ binId: "white-a", lineageId: "white-line", colour: "WHITE", quantity: 8 }),
      row({ binId: "red-a", lineageId: "red-line", colour: "white", quantity: 5 }),
      row({ binId: "red-b", lineageId: "red-line-2", colour: "White", quantity: 6 }),
      row({ binId: "rose-a", lineageId: "rose-line", colour: "white", quantity: 2 }),
    ];

    expect(
      suggestPutAway({ wine: { lineageId: "new-line", colour: "wHiTe" }, inventoryRows, bins }),
    ).toEqual({ binId: "red-a", code: "R1", zone: "Reds", reason: "same_colour_zone" });
  });

  it("preserves input bin order when same-colour zone totals tie", () => {
    const bins = [
      bin({ id: "b-first", code: "B1", zone: "B" }),
      bin({ id: "a-second", code: "A1", zone: "A" }),
    ];
    const inventoryRows = [
      row({ binId: "a-second", lineageId: "a", colour: "Red", quantity: 4 }),
      row({ binId: "b-first", lineageId: "b", colour: "red", quantity: 4 }),
    ];

    expect(
      suggestPutAway({ wine: { lineageId: null, colour: "RED" }, inventoryRows, bins }),
    ).toEqual({ binId: "b-first", code: "B1", zone: "B", reason: "same_colour_zone" });
  });

  it("returns null without a non-null matching lineage or positive same-colour zone", () => {
    expect(
      suggestPutAway({
        wine: { lineageId: null, colour: null },
        inventoryRows: [row({ lineageId: null })],
        bins: [bin()],
      }),
    ).toBeNull();
  });

  it("does not mutate its inputs", () => {
    const wine = Object.freeze({ lineageId: "lineage-1", colour: "Red" });
    const inventoryRows = Object.freeze([Object.freeze(row())]);
    const bins = Object.freeze([Object.freeze(bin())]);

    expect(() => suggestPutAway({ wine, inventoryRows, bins })).not.toThrow();
    expect(() => findBottleMatches("jamet", inventoryRows)).not.toThrow();
  });
});
