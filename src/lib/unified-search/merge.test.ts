// P1 slice 1 — the unified tier-1 merge
// (docs/plans/2026-08-31-unified-search-companion-and-canonical-facts.md D4, §7 P1).
//
// One ranked list over three sources — the tenant's cellar, the LWIN
// catalogue, the X-Wines corpus — under the interim two-corpus contract:
// HONEST dedupe only. A merge happens on an identity key (an accepted P0
// link, or the cellar row's own canonical lwin7/xwines id), never on name
// similarity; a row nothing links stays its own result, because presenting
// two maybe-same rows as one is the false-merge class WS-IDENT exists to
// prevent. Cellar rows outrank catalogue rows at equal score, and a
// placeholder-identity cellar row is flagged provisional rather than being
// silently folded into the graph.
import { describe, expect, it } from "vitest";
import {
  mergeUnifiedResults,
  type CellarHit,
  type LwinHit,
  type XwinesHit,
} from "./merge";

function cellar(over: Partial<CellarHit> = {}): CellarHit {
  return {
    id: "w-1",
    name: "Koonunga Hill",
    producer: "Penfolds",
    vintage: 2019,
    region: "South Australia",
    country: "Australia",
    varietal: "Shiraz",
    colour: "Red",
    heroImageUrl: null,
    isEightysixed: false,
    quantity: null,
    bin: null,
    lwin7: null,
    xwinesWineId: null,
    score: 1,
    ...over,
  };
}

function lwin(over: Partial<LwinHit> = {}): LwinHit {
  return {
    lwinId: "1234567",
    displayName: "Penfolds, Koonunga Hill, South Australia",
    producer: "Penfolds",
    region: "South Australia",
    country: "Australia",
    colour: "Red",
    type: "Wine",
    score: 0.8,
    ...over,
  };
}

function xwines(over: Partial<XwinesHit> = {}): XwinesHit {
  return {
    wineId: 101,
    name: "Koonunga Hill",
    wineryName: "Penfolds",
    regionName: "South Australia",
    country: "Australia",
    type: "Red",
    imageUrl: null,
    score: 0.8,
    ...over,
  };
}

const NO_LINKS = new Map<string, number>();

describe("mergeUnifiedResults", () => {
  it("carries cellar availability through and leaves catalogue rows unknown", () => {
    // Slice 2b (D4: cellar rows add qty/bin). Availability is a tenant fact,
    // so a catalogue row's is unknown (null) — never an invented zero.
    const results = mergeUnifiedResults({
      cellar: [cellar({ quantity: 3, bin: "A4" })],
      lwin: [lwin()],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    const cellarRow = results.find((r) => r.kind === "cellar")!;
    expect(cellarRow.quantity).toBe(3);
    expect(cellarRow.bin).toBe("A4");
    const catalogueRow = results.find((r) => r.kind === "catalogue")!;
    expect(catalogueRow.quantity).toBeNull();
    expect(catalogueRow.bin).toBeNull();
  });

  it("keeps a genuine zero-bottle count distinct from unknown availability", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ quantity: 0, bin: null })],
      lwin: [],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results[0].quantity).toBe(0);
    expect(results[0].bin).toBeNull();
  });

  it("ranks by score descending across sources", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ id: "w-lo", score: 0.6 })],
      lwin: [lwin({ lwinId: "1111111", score: 0.9 })],
      xwines: [xwines({ wineId: 7, score: 0.7 })],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results.map((r) => r.provenance)).toEqual(["lwin", "xwines", "cellar"]);
  });

  it("puts the cellar row first at equal score — owned beats discoverable", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ score: 0.8 })],
      lwin: [lwin({ lwinId: "2222222", displayName: "Other, Wine", producer: "Other", score: 0.8 })],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results[0].kind).toBe("cellar");
    expect(results[1].kind).toBe("catalogue");
  });

  it("merges an accepted-link LWIN + X-Wines pair into one catalogue row", () => {
    const results = mergeUnifiedResults({
      cellar: [],
      lwin: [lwin()],
      xwines: [xwines()],
      acceptedLinks: new Map([["1234567", 101]]),
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "catalogue",
      provenance: "lwin+xwines",
      deduped: true,
      lwinId: "1234567",
      xwinesWineId: 101,
    });
  });

  it("keeps an unlinked X-Wines row separate — similarity alone never dedupes", () => {
    // Same producer, same-looking name, NO accepted link: two rows, honestly.
    const results = mergeUnifiedResults({
      cellar: [],
      lwin: [lwin()],
      xwines: [xwines()],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.deduped === false)).toBe(true);
  });

  it("absorbs the linked X-Wines features even when only the LWIN side matched the query", () => {
    const results = mergeUnifiedResults({
      cellar: [],
      lwin: [lwin()],
      xwines: [], // the corpus row did not surface on its own
      acceptedLinks: new Map([["1234567", 101]]),
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provenance: "lwin+xwines", xwinesWineId: 101, deduped: false });
  });

  it("folds a catalogue row into the cellar row that owns its identity via lwin7", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ lwin7: "1234567", score: 0.9 })],
      lwin: [lwin({ score: 0.95 })],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "cellar",
      deduped: true,
      lwinId: "1234567",
    });
  });

  it("folds the whole linked pair into a cellar row that owns either half", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ xwinesWineId: 101 })],
      lwin: [lwin()],
      xwines: [xwines()],
      acceptedLinks: new Map([["1234567", 101]]),
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "cellar",
      deduped: true,
      xwinesWineId: 101,
      lwinId: "1234567",
    });
  });

  it("never folds catalogue rows into a cellar row with no identity keys", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar()],
      lwin: [lwin()],
      xwines: [xwines()],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results).toHaveLength(3);
  });

  it("flags placeholder-identity cellar rows as provisional", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ id: "w-a", producer: "Unknown" }), cellar({ id: "w-b", producer: "  " })],
      lwin: [],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(results.map((r) => r.provisional)).toEqual([true, true]);
  });

  it("applies the limit after merging, keeping the top-ranked rows", () => {
    const results = mergeUnifiedResults({
      cellar: [cellar({ id: "w-1", score: 0.9 }), cellar({ id: "w-2", score: 0.5 })],
      lwin: [lwin({ lwinId: "3333333", score: 0.7 })],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 2,
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.score)).toEqual([0.9, 0.7]);
  });

  it("breaks exact ties deterministically — same input order or shuffled, same output", () => {
    const a = mergeUnifiedResults({
      cellar: [],
      lwin: [lwin({ lwinId: "2222222", score: 0.8 }), lwin({ lwinId: "1111111", score: 0.8 })],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    const b = mergeUnifiedResults({
      cellar: [],
      lwin: [lwin({ lwinId: "1111111", score: 0.8 }), lwin({ lwinId: "2222222", score: 0.8 })],
      xwines: [],
      acceptedLinks: NO_LINKS,
      limit: 10,
    });
    expect(a.map((r) => r.lwinId)).toEqual(b.map((r) => r.lwinId));
    expect(a.map((r) => r.lwinId)).toEqual(["1111111", "2222222"]);
  });
});
