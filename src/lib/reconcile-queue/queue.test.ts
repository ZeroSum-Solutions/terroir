import { describe, expect, it } from "vitest";
import {
  buildDuplicateSources,
  buildReconcileQueue,
  parseBottleFormat,
  rankQueueRows,
  suggestWineMatch,
  type QueueSourceInput,
  type ReconcileQueueRow,
  type WineMatchCandidate,
  type WineMatchIdentity,
} from "./index";

function source(
  subjectId: string,
  units: number,
  unitCost: number,
  overrides: Partial<QueueSourceInput> = {},
): QueueSourceInput {
  return {
    subjectTable: "inventory_items",
    subjectId,
    title: `Subject ${subjectId}`,
    detail: "Needs review",
    units,
    unitCost,
    ...overrides,
  };
}

function row(id: string, units: number, unitCost: number): ReconcileQueueRow {
  return {
    id,
    kind: "unplaced",
    subjectTable: "inventory_items",
    subjectId: id,
    title: id,
    detail: "Needs a bin",
    units,
    unitCost,
    atRisk: units * unitCost,
  };
}

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

describe("buildReconcileQueue", () => {
  it("EV-5.1: preserves each source record at item grain and reports items, units, and capital", () => {
    const result = buildReconcileQueue({
      unplaced: [source("inv-1", 3, 20, { wineId: "wine-1" })],
      unmatchedScans: [
        source("scan-1:line-2", 2, 45, {
          subjectTable: "invoice_scan_lines",
          action: { type: "match_scan", label: "Match wine" },
        }),
      ],
      duplicateSuspects: [
        source("lineage-1:2019:750", 4, 50, {
          subjectTable: "wine_lineages",
        }),
      ],
      ambiguousLineages: [
        source("wine-9", 1, 160, {
          subjectTable: "wines",
          deepLink: "/cellar/wine-9",
        }),
      ],
    });

    expect(result.rows.map((item) => item.kind).sort()).toEqual([
      "ambiguous_lineage",
      "duplicate_suspect",
      "unmatched_scan",
      "unplaced",
    ]);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.map((item) => item.subjectId).sort()).toEqual([
      "inv-1",
      "lineage-1:2019:750",
      "scan-1:line-2",
      "wine-9",
    ]);
    expect(result.summary).toEqual({ itemCount: 4, unitCount: 10, atRisk: 510 });
    expect(result.rows.find((item) => item.subjectId === "inv-1")?.id).toBe(
      "reconcile:unplaced:inventory_items:inv-1",
    );
    expect(result.rows.find((item) => item.subjectId === "scan-1:line-2")?.action).toEqual({
      type: "match_scan",
      label: "Match wine",
    });
  });

  it("EV-5.1: does not coalesce different queue records that point at the same wine", () => {
    const result = buildReconcileQueue({
      unplaced: [source("inv-1", 2, 30, { wineId: "wine-1" })],
      unmatchedScans: [],
      duplicateSuspects: [
        source("dupe-1", 2, 30, {
          subjectTable: "wine_lineages",
          wineId: "wine-1",
        }),
      ],
      ambiguousLineages: [],
    });

    expect(result.rows.map((item) => item.kind)).toEqual([
      "duplicate_suspect",
      "unplaced",
    ]);
    expect(result.summary).toEqual({ itemCount: 2, unitCount: 4, atRisk: 120 });
  });

  it("EV-5.2: ranks by units times unit cost, not source order or recency metadata", () => {
    const result = buildReconcileQueue({
      unplaced: [
        source("newest-low", 1, 20, { metadata: { createdAt: "2026-08-19" } }),
        source("oldest-high", 5, 70, { metadata: { createdAt: "2020-01-01" } }),
      ],
      unmatchedScans: [source("middle", 3, 50)],
      duplicateSuspects: [],
      ambiguousLineages: [],
    });

    expect(result.rows.map((item) => [item.subjectId, item.atRisk])).toEqual([
      ["oldest-high", 350],
      ["middle", 150],
      ["newest-low", 20],
    ]);
  });

  it("EV-5.1 (seeded property): unification never drops or double-counts source records", () => {
    const seed = 20260819;
    const random = lcg(seed);
    for (let run = 0; run < 100; run++) {
      const groups = [0, 1, 2, 3].map((group) =>
        Array.from({ length: Math.floor(random() * 12) }, (_, index) =>
          source(`${group}-${run}-${index}`, 1 + Math.floor(random() * 12), Math.floor(random() * 500)),
        ),
      );
      const all = groups.flat();
      const result = buildReconcileQueue({
        unplaced: groups[0],
        unmatchedScans: groups[1],
        duplicateSuspects: groups[2],
        ambiguousLineages: groups[3],
      });
      const actualSubjects = result.rows.map((item) => item.subjectId).sort();
      const expectedSubjects = all.map((item) => item.subjectId).sort();
      const expectedUnits = all.reduce((sum, item) => sum + item.units, 0);
      const expectedRisk = all.reduce((sum, item) => sum + item.units * item.unitCost, 0);

      expect(actualSubjects, `seed ${seed} run ${run}`).toEqual(expectedSubjects);
      expect(result.summary, `seed ${seed} run ${run}`).toEqual({
        itemCount: all.length,
        unitCount: expectedUnits,
        atRisk: expectedRisk,
      });
    }
  });
});

describe("rankQueueRows", () => {
  it("EV-5.2 (seeded property): ranking is total and deterministic across input permutations", () => {
    const seed = 5102;
    const random = lcg(seed);
    for (let run = 0; run < 100; run++) {
      const rows = Array.from({ length: 2 + Math.floor(random() * 30) }, (_, index) =>
        row(`row-${run}-${String(index).padStart(2, "0")}`, 1 + Math.floor(random() * 5), Math.floor(random() * 6)),
      );
      const expected = rankQueueRows(rows).map((item) => item.id);
      const reranked = rankQueueRows(shuffle(rows, random));

      expect(reranked.map((item) => item.id), `seed ${seed} run ${run}`).toEqual(expected);
      expect(new Set(reranked.map((item) => item.id)).size).toBe(rows.length);
      for (let index = 1; index < reranked.length; index++) {
        const previous = reranked[index - 1];
        const current = reranked[index];
        expect(
          previous.atRisk > current.atRisk ||
            (previous.atRisk === current.atRisk && previous.id.localeCompare(current.id) < 0),
          `seed ${seed} run ${run} index ${index}`,
        ).toBe(true);
      }
    }
  });
});

describe("match suggestions", () => {
  const candidate: WineMatchCandidate = {
    wineId: "wine-2019",
    title: "Domaine Jamet Côte-Rôtie 2019",
    lwin: "1012345",
    producer: "Domaine Jamet",
    cuvee: "Côte-Rôtie",
    vintage: 2019,
    format: 750,
    deepLink: "/cellar/wine-2019",
  };

  it("EV-5.3: cites an exact LWIN identity match", () => {
    const suggestion = suggestWineMatch(
      { lwin: "1012345", producer: "Wrong", cuvee: "Wrong", vintage: 2000, format: "1.5L" },
      [candidate],
    );

    expect(suggestion).toEqual({
      wineId: "wine-2019",
      title: candidate.title,
      deepLink: candidate.deepLink,
      basis: { kind: "lwin", lwin: "1012345" },
    });
  });

  it("EV-5.3: cites all four fields for an exact case-insensitive field match", () => {
    const scan: WineMatchIdentity = {
      producer: "  DOMAINE JAMET ",
      cuvee: "côte-rôtie",
      vintage: 2019,
      format: "750 ml",
    };

    expect(suggestWineMatch(scan, [candidate])?.basis).toEqual({
      kind: "field_match",
      fields: ["producer", "cuvee", "vintage", "format"],
    });
  });

  it("EV-5.3: refuses fuzzy, partial, wrong-vintage, wrong-format, and ambiguous matches", () => {
    const cases: WineMatchIdentity[] = [
      { producer: "Jamet", cuvee: "Côte-Rôtie", vintage: 2019, format: "750ml" },
      { producer: "Domaine Jamet", cuvee: "Côte Rôtie", vintage: 2019, format: "750ml" },
      { producer: "Domaine Jamet", cuvee: "Côte-Rôtie", vintage: 2020, format: "750ml" },
      { producer: "Domaine Jamet", cuvee: "Côte-Rôtie", vintage: 2019, format: "1.5L" },
      { producer: "Domaine Jamet", cuvee: "Côte-Rôtie", vintage: 2019, format: "Bottle 750ml" },
    ];
    for (const scan of cases) expect(suggestWineMatch(scan, [candidate])).toBeNull();
    expect(suggestWineMatch(cases[4], [{ ...candidate, format: "Bottle 750ml" }])).toBeNull();
    expect(
      suggestWineMatch(
        { producer: "Domaine Jamet", cuvee: "Côte-Rôtie", vintage: 2019, format: "750ml" },
        [candidate, { ...candidate, wineId: "wine-other" }],
      ),
    ).toBeNull();
  });
});

describe("parseBottleFormat", () => {
  it.each([
    ["375ml", 375],
    ["750 ml", 750],
    ["75cl", 750],
    ["1.5L", 1500],
    ["3 l", 3000],
    [1500, 1500],
  ])("parses the exact common format %j", (input, expected) => {
    expect(parseBottleFormat(input)).toBe(expected);
  });

  it.each(["Bottle 750ml", "750ml case", "0ml", "1.333L", "", 0, -750])(
    "rejects non-exact or invalid format %j",
    (input) => {
      expect(parseBottleFormat(input)).toBeNull();
    },
  );
});

describe("buildDuplicateSources", () => {
  it("uses lineage, vintage, and format duplicate groups without pairing unrelated wines", () => {
    const sources = buildDuplicateSources(
      [
        { id: "wine-a", lineageId: "lin-1", producer: "Jamet", name: "Côte-Rôtie", vintage: 2019, sizeMl: 750, quantity: 2, value: 200, unitCost: 100 },
        { id: "wine-b", lineageId: "lin-1", producer: "Jamet", name: "Côte-Rôtie", vintage: 2019, sizeMl: 750, quantity: 3, value: 360, unitCost: 120 },
        { id: "wine-c", lineageId: "lin-1", producer: "Jamet", name: "Côte-Rôtie", vintage: 2020, sizeMl: 750, quantity: 9, value: 900, unitCost: 100 },
      ],
      { latestUnitCostBySubject: { "lin-1:2019:750": 130 } },
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      subjectTable: "wine_lineages",
      subjectId: "lin-1:2019:750",
      units: 5,
      unitCost: 130,
      metadata: { wineIds: ["wine-a", "wine-b"] },
    });
  });
});
