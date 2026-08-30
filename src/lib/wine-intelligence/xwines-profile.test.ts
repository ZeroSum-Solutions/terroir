import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  acidityAxis,
  bodyAxis,
  fetchVintageRatings,
  resolveXWinesProfile,
  toImage,
  XWINES_NAME_FLOOR,
  XWINES_PRODUCER_FLOOR,
  XWINES_SCORE_FLOOR,
} from "./xwines-profile";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// A catalog row as the corpus actually stores one (Penfolds Koonunga Hill,
// wine_id 174177 in the seeded local corpus).
const CATALOG_ROW = {
  wine_id: 174177,
  name: "Koonunga Hill Shiraz-Cabernet",
  winery_name: "Penfolds",
  type: "Red",
  elaborate: "Assemblage/Blend",
  grapes: ["Syrah/Shiraz", "Cabernet Sauvignon"],
  harmonize: ["Beef", "Lamb", "Poultry"],
  abv: 14.0,
  body: "Very full-bodied",
  acidity: "High",
  region_name: "South Australia",
  country: "Australia",
  website: "https://www.penfolds.com",
  vintages: [2018, 2017, 2016],
  has_non_vintage: false,
  rating_avg: 3.639,
  rating_count: 6666,
  image_url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/xwines/174177.jpeg",
  image_kind: "label",
  image_source: "xwines",
  image_credit: null,
};

type Recorded = { table: string; filters: Record<string, unknown> };

/**
 * Minimal Supabase double. Builders are PLAIN thenables rather than promises
 * with an assigned `then`: `await` short-circuits a native promise, so an own
 * `then` on one never runs and the mock silently records nothing.
 */
type VintageRow = { vintage: number; rating_avg: number; rating_count: number };
type MatchRow = {
  wine_id: number;
  score: number;
  producer_score: number;
  name_score: number;
};

function fakeSupabase(options: {
  canonical?: { xwines_wine_id: number | null } | null;
  catalog?: typeof CATALOG_ROW | null;
  match?: MatchRow[];
  vintages?: VintageRow[];
  /** Which read fails, so "we could not ask" can be told from "nothing here". */
  fail?: "canonical" | "catalog" | "match" | "vintages";
}) {
  const calls: Recorded[] = [];
  const error = { message: "boom" };

  function builder(table: string, result: unknown, fails: boolean) {
    const filters: Record<string, unknown> = {};
    const settle = () => {
      calls.push({ table, filters });
      const payload = fails ? { data: null, error } : { data: result, error: null };
      return { then: (r: (v: unknown) => unknown) => r(payload) };
    };
    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return self;
      },
      order: () => self,
      limit: settle,
      maybeSingle: settle,
    };
    return self;
  }

  const supabase = {
    from: (table: string) => {
      if (table === "canonical_wines")
        return builder(table, options.canonical ?? null, options.fail === "canonical");
      if (table === "xwines_catalog")
        return builder(table, options.catalog ?? null, options.fail === "catalog");
      if (table === "xwines_vintage_ratings") {
        // The own-vintage top-up is a maybeSingle() on the same table; serve it
        // the one matching row rather than the whole window.
        const filters: Record<string, unknown> = {};
        const rows = options.vintages ?? [];
        const settle = (result: unknown) => {
          calls.push({ table, filters });
          const payload =
            options.fail === "vintages" ? { data: null, error } : { data: result, error: null };
          return { then: (r: (v: unknown) => unknown) => r(payload) };
        };
        const self = {
          select: () => self,
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return self;
          },
          order: () => self,
          limit: (n: number) => settle(rows.slice(0, n)),
          maybeSingle: () =>
            settle(rows.find((row) => row.vintage === filters.vintage) ?? null),
        };
        return self;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: `rpc:${fn}`, filters: args as Record<string, unknown> });
      const payload =
        options.fail === "match"
          ? { data: null, error }
          : { data: options.match ?? [], error: null };
      return { then: (r: (v: unknown) => unknown) => r(payload) };
    },
  } as unknown as SupabaseClient<Database>;

  return { supabase, calls };
}

/** Unwraps a successful read, failing loudly if it wasn't one. */
function value<T>(read: { status: "ok"; value: T } | { status: "unavailable" }): T {
  expect(read.status).toBe("ok");
  return (read as { status: "ok"; value: T }).value;
}

describe("taste axes", () => {
  it("places every corpus body value on the Light-Bold axis in order", () => {
    const order = [
      "Very light-bodied",
      "Light-bodied",
      "Medium-bodied",
      "Full-bodied",
      "Very full-bodied",
    ];
    const positions = order.map((value) => bodyAxis(value)!.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(order.length);
    expect(bodyAxis("Full-bodied")).toEqual({
      low: "Light",
      high: "Bold",
      position: 0.75,
      label: "Full-bodied",
    });
  });

  it("places every corpus acidity value on the Soft-Acidic axis in order", () => {
    const positions = ["Low", "Medium", "High"].map((v) => acidityAxis(v)!.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(acidityAxis("High")!.label).toBe("High acidity");
  });

  it("returns null rather than guessing for absent or unrecognised values", () => {
    expect(bodyAxis(null)).toBeNull();
    expect(acidityAxis(null)).toBeNull();
    expect(bodyAxis("Sturdy")).toBeNull();
    expect(acidityAxis("Zippy")).toBeNull();
  });
});

describe("resolveXWinesProfile — acceptance rule", () => {
  const base = { canonicalWineId: null, producer: "Penfolds", name: "Koonunga Hill" };
  const candidate = (over: Partial<MatchRow> = {}): MatchRow => ({
    wine_id: 174177,
    score: 0.94,
    producer_score: 1,
    name_score: 0.9,
    ...over,
  });

  it("accepts a match clearing every floor", async () => {
    const { supabase } = fakeSupabase({ match: [candidate()], catalog: CATALOG_ROW });
    const profile = value(await resolveXWinesProfile({ supabase, ...base }));
    expect(profile).not.toBeNull();
    expect(profile!.provenance).toBe("matched");
    expect(profile!.matchScore).toBe(0.94);
    expect(profile!.body!.label).toBe("Very full-bodied");
    expect(profile!.pairings).toEqual(["Beef", "Lamb", "Poultry"]);
  });

  it("rejects a wrong producer carried by an exact cuvée name (the Borsao/Muga case)", async () => {
    // Real measured values: blended 0.667 clears the score floor, producer
    // 0.444 does not. Without the independent producer floor this row would be
    // served as if it described Bodegas Muga.
    const { supabase } = fakeSupabase({
      match: [candidate({ wine_id: 999, score: 0.667, producer_score: 0.444, name_score: 1 })],
      catalog: CATALOG_ROW,
    });
    expect(
      value(
        await resolveXWinesProfile({
          supabase,
          ...base,
          producer: "Bodegas Muga",
          name: "Reserva",
        }),
      ),
    ).toBeNull();
  });

  it("rejects the right producer's WRONG cuvée", async () => {
    // The defect the name floor exists for: producer 1.0 contributes 0.6 on its
    // own, so any cuvée clearing the RPC's 0.21 prefilter blended over 0.65 and
    // was served — "Estate Cabernet" enriched with "Reserve Cabernet"'s grapes,
    // body, acidity and pairings, presented as fact.
    const { supabase } = fakeSupabase({
      match: [candidate({ wine_id: 999, score: 0.684, producer_score: 1, name_score: 0.21 })],
      catalog: CATALOG_ROW,
    });
    expect(
      value(
        await resolveXWinesProfile({
          supabase,
          ...base,
          producer: "Producer X",
          name: "Estate Cabernet",
        }),
      ),
    ).toBeNull();
  });

  it("rejects a match below the blended score floor even with a perfect producer", async () => {
    const { supabase } = fakeSupabase({
      match: [candidate({ wine_id: 999, score: 0.462 })],
      catalog: CATALOG_ROW,
    });
    expect(value(await resolveXWinesProfile({ supabase, ...base }))).toBeNull();
  });

  it("holds all three floors at the documented values", async () => {
    // Exactly-at-floor must pass; a hair under must not. Pins the boundaries so
    // a later loosening is a deliberate edit, not a drift.
    const atFloor = fakeSupabase({
      match: [
        candidate({
          score: XWINES_SCORE_FLOOR,
          producer_score: XWINES_PRODUCER_FLOOR,
          name_score: XWINES_NAME_FLOOR,
        }),
      ],
      catalog: CATALOG_ROW,
    });
    expect(
      value(await resolveXWinesProfile({ supabase: atFloor.supabase, ...base })),
    ).not.toBeNull();

    const under = async (over: Partial<MatchRow>) => {
      const { supabase } = fakeSupabase({
        match: [candidate({ score: 1, producer_score: 1, name_score: 1, ...over })],
        catalog: CATALOG_ROW,
      });
      return value(await resolveXWinesProfile({ supabase, ...base }));
    };
    expect(await under({ score: XWINES_SCORE_FLOOR - 0.001 })).toBeNull();
    expect(await under({ producer_score: XWINES_PRODUCER_FLOOR - 0.001 })).toBeNull();
    expect(await under({ name_score: XWINES_NAME_FLOOR - 0.001 })).toBeNull();
  });

  it("walks past a rejected leader to a candidate that clears every floor", async () => {
    // 0134 made the RPC return the top N. Its bar is looser than this module's,
    // so the top row is routinely rejected here — and under `limit 1` the
    // acceptable runner-up behind it was never sent at all.
    const { supabase } = fakeSupabase({
      match: [
        candidate({ wine_id: 111839, score: 0.744, producer_score: 1, name_score: 0.36 }),
        candidate({ wine_id: 174177, score: 0.9, producer_score: 1, name_score: 0.75 }),
      ],
      catalog: CATALOG_ROW,
    });
    const profile = value(await resolveXWinesProfile({ supabase, ...base }));
    expect(profile!.matchScore).toBe(0.9);
  });

  it("returns an ordinary miss when the matcher finds nothing", async () => {
    const { supabase } = fakeSupabase({ match: [] });
    expect(value(await resolveXWinesProfile({ supabase, ...base }))).toBeNull();
  });

  it("does not call the matcher without a producer to corroborate against", async () => {
    const { supabase, calls } = fakeSupabase({ match: [] });
    expect(value(await resolveXWinesProfile({ supabase, ...base, producer: null }))).toBeNull();
    expect(value(await resolveXWinesProfile({ supabase, ...base, producer: "   " }))).toBeNull();
    expect(calls.filter((c) => c.table === "rpc:match_xwines")).toHaveLength(0);
  });
});

describe("corpus imagery", () => {
  // 0138 stores three different strengths of claim in one column. A reader that
  // loses the kind renders a stranger's bottle as this wine's label, so these
  // pin that the kind survives the read and that an unreadable one drops the
  // picture rather than guessing which of the three it was.
  const row = (over: Record<string, unknown>) => ({ ...CATALOG_ROW, ...over });

  it("carries the picture and its kind onto the profile", async () => {
    const { supabase } = fakeSupabase({
      canonical: { xwines_wine_id: 174177 },
      catalog: row({
        image_kind: "producer",
        image_source: "openfoodfacts",
        image_credit: "Open Food Facts contributors, CC-BY-SA-3.0 (3500610095429)",
      }) as typeof CATALOG_ROW,
    });
    const profile = value(
      await resolveXWinesProfile({
        supabase,
        canonicalWineId: "c0000000-0000-4000-8000-000000000001",
        producer: "Penfolds",
        name: "Koonunga Hill",
      }),
    );
    expect(profile!.image).toEqual({
      url: CATALOG_ROW.image_url,
      kind: "producer",
      source: "openfoodfacts",
      credit: "Open Food Facts contributors, CC-BY-SA-3.0 (3500610095429)",
    });
  });

  it("accepts each kind the corpus is allowed to store", () => {
    for (const kind of ["label", "producer", "representative"]) {
      expect(toImage(row({ image_kind: kind }))!.kind).toBe(kind);
    }
  });

  it("drops a picture whose kind it cannot read rather than assuming one", () => {
    // Not a hypothetical safety net: promoting an unknown kind to "label"
    // asserts a bottle, and demoting it to "representative" hides a real
    // label. Neither is answerable from the row, so there is no picture.
    expect(toImage(row({ image_kind: "hero" }))).toBeNull();
    expect(toImage(row({ image_kind: null }))).toBeNull();
  });

  it("drops a picture with no URL or no recorded source", () => {
    expect(toImage(row({ image_url: null }))).toBeNull();
    expect(toImage(row({ image_source: null }))).toBeNull();
  });
});

describe("resolveXWinesProfile — a failure is not a miss", () => {
  const base = { canonicalWineId: null, producer: "Penfolds", name: "Koonunga Hill" };

  it("reports the matcher failing as unavailable, not as an absent wine", async () => {
    const { supabase } = fakeSupabase({ fail: "match" });
    expect(await resolveXWinesProfile({ supabase, ...base })).toEqual({
      status: "unavailable",
    });
  });

  it("reports a failed catalog read as unavailable", async () => {
    const { supabase } = fakeSupabase({
      match: [{ wine_id: 174177, score: 1, producer_score: 1, name_score: 1 }],
      fail: "catalog",
    });
    expect(await resolveXWinesProfile({ supabase, ...base })).toEqual({
      status: "unavailable",
    });
  });

  it("reports a failed canonical-link lookup rather than silently matching instead", async () => {
    const { supabase, calls } = fakeSupabase({ fail: "canonical" });
    expect(
      await resolveXWinesProfile({ supabase, ...base, canonicalWineId: "c-1" }),
    ).toEqual({ status: "unavailable" });
    expect(calls.filter((c) => c.table === "rpc:match_xwines")).toHaveLength(0);
  });
});

describe("resolveXWinesProfile — explicit link", () => {
  it("prefers an explicit canonical link and never runs the matcher", async () => {
    const { supabase, calls } = fakeSupabase({
      canonical: { xwines_wine_id: 174177 },
      catalog: CATALOG_ROW,
    });
    const profile = value(
      await resolveXWinesProfile({
        supabase,
        canonicalWineId: "c-1",
        producer: "Penfolds",
        name: "Koonunga Hill",
      }),
    );
    expect(profile!.provenance).toBe("linked");
    expect(profile!.matchScore).toBeNull();
    expect(calls.filter((c) => c.table === "rpc:match_xwines")).toHaveLength(0);
  });

  it("falls back to matching when the canonical row carries no link", async () => {
    const { supabase, calls } = fakeSupabase({
      canonical: { xwines_wine_id: null },
      match: [{ wine_id: 174177, score: 0.9, producer_score: 1, name_score: 0.9 }],
      catalog: CATALOG_ROW,
    });
    const profile = value(
      await resolveXWinesProfile({
        supabase,
        canonicalWineId: "c-1",
        producer: "Penfolds",
        name: "Koonunga Hill",
      }),
    );
    expect(profile!.provenance).toBe("matched");
    expect(calls.filter((c) => c.table === "rpc:match_xwines")).toHaveLength(1);
  });
});

describe("fetchVintageRatings", () => {
  it("returns newest vintage first regardless of the fetch ordering", async () => {
    const { supabase } = fakeSupabase({
      vintages: [
        { vintage: 2015, rating_avg: 4.2, rating_count: 900 },
        { vintage: 2019, rating_avg: 3.9, rating_count: 400 },
        { vintage: 2017, rating_avg: 4.0, rating_count: 120 },
      ],
    });
    const rows = value(await fetchVintageRatings(supabase, 174177));
    expect(rows.map((r) => r.vintage)).toEqual([2019, 2017, 2015]);
  });

  it("returns an empty list when the wine has no rated vintages", async () => {
    const { supabase } = fakeSupabase({ vintages: [] });
    expect(value(await fetchVintageRatings(supabase, 1))).toEqual([]);
  });

  it("keeps the bottle's own vintage even when it misses the most-reviewed window", async () => {
    // The window is ordered by rating_count, so a lightly-rated vintage falls
    // out of it — and the table whose whole job is to locate the reader's
    // bottle would then not contain it, reading as "yours has no ratings".
    const vintages = [
      { vintage: 2019, rating_avg: 4.1, rating_count: 900 },
      { vintage: 2018, rating_avg: 4.0, rating_count: 800 },
      { vintage: 2012, rating_avg: 3.8, rating_count: 3 },
    ];
    const { supabase } = fakeSupabase({ vintages });
    const rows = value(await fetchVintageRatings(supabase, 174177, 2012, 2));
    expect(rows.map((r) => r.vintage)).toEqual([2019, 2018, 2012]);
  });

  it("does not spend a second query when the window already holds it", async () => {
    const { supabase, calls } = fakeSupabase({
      vintages: [
        { vintage: 2019, rating_avg: 4.1, rating_count: 900 },
        { vintage: 2018, rating_avg: 4.0, rating_count: 800 },
      ],
    });
    value(await fetchVintageRatings(supabase, 174177, 2018));
    expect(calls.filter((c) => c.table === "xwines_vintage_ratings")).toHaveLength(1);
  });

  it("adds nothing when the bottle's own vintage has no ratings at all", async () => {
    const { supabase } = fakeSupabase({
      vintages: [{ vintage: 2019, rating_avg: 4.1, rating_count: 900 }],
    });
    const rows = value(await fetchVintageRatings(supabase, 174177, 1998, 1));
    expect(rows.map((r) => r.vintage)).toEqual([2019]);
  });

  it("reports a failed read as unavailable rather than as no ratings", async () => {
    const { supabase } = fakeSupabase({ fail: "vintages" });
    expect(await fetchVintageRatings(supabase, 174177)).toEqual({ status: "unavailable" });
  });
});
