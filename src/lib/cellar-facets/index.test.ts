import { describe, expect, it } from "vitest";
import {
  applyFacets,
  facetCounts,
  groupRows,
  type CellarFacetRow,
  type CellarFacets,
  type FacetDimension,
} from ".";

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
    ...overrides,
  };
}

const rows = [
  wine(),
  wine({
    wine_id: "wine-2",
    region: "Sonoma",
    varietal: "Pinot Noir",
    vintage: 2020,
    sealed_count: 2,
  }),
  wine({
    wine_id: "wine-3",
    producer: "Beta Cellars",
    vintage: 2021,
    wine_size_ml: 1_500,
    sealed_count: 5,
  }),
  wine({
    wine_id: "wine-4",
    producer: "Beta Cellars",
    region: "Barossa",
    country: "Australia",
    varietal: null,
    vintage: null,
    sealed_count: 1,
  }),
];

describe("applyFacets", () => {
  it("EV-4.1: combines every taxonomy facet with case-insensitive exact matching", () => {
    expect(
      applyFacets(rows, {
        producer: "ALPHA ESTATE",
        region: "napa",
        country: "usa",
        varietal: "cabernet sauvignon",
        vintageMin: 2018,
        vintageMax: 2019,
        format: 750,
      }).map((row) => row.wine_id),
    ).toEqual(["wine-1"]);
  });

  it("EV-4.1 (property): filters compose commutatively across randomized cellars", () => {
    const rand = lcg(20260819);
    for (let run = 0; run < 100; run++) {
      const randomRows = Array.from({ length: 30 }, (_, index) =>
        wine({
          wine_id: `${run}-${index}`,
          producer: rand() < 0.5 ? "Alpha" : "Beta",
          region: rand() < 0.5 ? "North" : "South",
          country: rand() < 0.5 ? "France" : "Italy",
        }),
      );
      const producer = { producer: "alpha" } satisfies CellarFacets;
      const region = { region: "north" } satisfies CellarFacets;
      const left = applyFacets(applyFacets(randomRows, producer), region);
      const right = applyFacets(applyFacets(randomRows, region), producer);
      const combined = applyFacets(randomRows, { ...producer, ...region });
      expect(ids(left), `seed run ${run}`).toEqual(ids(right));
      expect(ids(left), `seed run ${run}`).toEqual(ids(combined));
    }
  });
});

describe("facetCounts", () => {
  it("EV-4.1: reports self-excluding counts for the current combined filter set", () => {
    const counts = facetCounts(rows, {
      producer: "Alpha Estate",
      region: "Napa",
    });

    expect(counts.producer).toEqual([
      { value: "Alpha Estate", label: "Alpha Estate", count: 1 },
      { value: "Beta Cellars", label: "Beta Cellars", count: 1 },
    ]);
    expect(counts.region).toEqual([
      { value: "Napa", label: "Napa", count: 1 },
      { value: "Sonoma", label: "Sonoma", count: 1 },
    ]);
    expect(counts.country).toEqual([
      { value: "USA", label: "USA", count: 1 },
    ]);
  });

  it("EV-4.1 (property): every dimension count sums to its self-excluding result", () => {
    const rand = lcg(404);
    const dimensions: FacetDimension[] = [
      "producer",
      "region",
      "country",
      "varietal",
      "vintage",
      "format",
    ];
    for (let run = 0; run < 100; run++) {
      const randomRows = Array.from({ length: 40 }, (_, index) =>
        wine({
          wine_id: `${run}-${index}`,
          producer: rand() < 0.5 ? "Alpha" : "Beta",
          region: rand() < 0.15 ? null : rand() < 0.5 ? "North" : "South",
          country: rand() < 0.5 ? "France" : "Italy",
          varietal: rand() < 0.15 ? null : rand() < 0.5 ? "Syrah" : "Merlot",
          vintage: rand() < 0.15 ? null : 2018 + Math.floor(rand() * 3),
          wine_size_ml: rand() < 0.5 ? 750 : 1_500,
        }),
      );
      const facets: CellarFacets = {
        producer: "Alpha",
        region: "North",
        country: "France",
        varietal: "Syrah",
        vintageMin: 2018,
        vintageMax: 2019,
        format: 750,
      };
      const counts = facetCounts(randomRows, facets);
      for (const dimension of dimensions) {
        const expected = applyFacets(
          randomRows,
          withoutDimension(facets, dimension),
        ).length;
        expect(sum(counts[dimension]), `seed run ${run} ${dimension}`).toBe(expected);
      }
    }
  });
});

describe("groupRows", () => {
  it("EV-4.2: groups by each supported taxonomy dimension", () => {
    expect(groupRows(rows, "producer").map((group) => group.label)).toEqual([
      "Alpha Estate",
      "Beta Cellars",
    ]);
    expect(groupRows(rows, "region").map((group) => group.label)).toEqual([
      "Barossa",
      "Napa",
      "Sonoma",
    ]);
    expect(groupRows(rows, "varietal").map((group) => group.label)).toEqual([
      "Cabernet Sauvignon",
      "Pinot Noir",
      "Unknown",
    ]);
    expect(groupRows(rows, "vintage").map((group) => group.label)).toEqual([
      "2021",
      "2020",
      "2018",
      "Unknown",
    ]);
  });

  it("EV-4.2 (property): every rollup exactly equals the sum of its members", () => {
    const rand = lcg(42);
    for (let run = 0; run < 100; run++) {
      const randomRows = Array.from({ length: 50 }, (_, index) =>
        wine({
          wine_id: `${run}-${index}`,
          producer: `Producer ${Math.floor(rand() * 5)}`,
          region: rand() < 0.1 ? null : `Region ${Math.floor(rand() * 4)}`,
          varietal: rand() < 0.1 ? null : `Varietal ${Math.floor(rand() * 3)}`,
          vintage: rand() < 0.1 ? null : 2000 + Math.floor(rand() * 25),
          sealed_count: Math.floor(rand() * 20),
        }),
      );
      for (const by of ["producer", "region", "varietal", "vintage"] as const) {
        const groups = groupRows(randomRows, by);
        expect(groups.flatMap((group) => group.wines).length).toBe(randomRows.length);
        for (const group of groups) {
          expect(group.wineCount).toBe(group.wines.length);
          expect(group.totalBottles).toBe(
            group.wines.reduce((total, row) => total + row.sealed_count, 0),
          );
        }
      }
    }
  });
});

function withoutDimension(
  facets: CellarFacets,
  dimension: FacetDimension,
): CellarFacets {
  const next = { ...facets };
  if (dimension === "vintage") {
    delete next.vintageMin;
    delete next.vintageMax;
  } else {
    delete next[dimension];
  }
  return next;
}

function ids(items: CellarFacetRow[]) {
  return items.map((item) => item.wine_id).sort();
}

function sum(items: Array<{ count: number }>) {
  return items.reduce((total, item) => total + item.count, 0);
}

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
