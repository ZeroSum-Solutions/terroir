import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  acidityAxis,
  bodyAxis,
  fetchVintageRatings,
  resolveXWinesProfile,
  XWINES_PRODUCER_FLOOR,
  XWINES_SCORE_FLOOR,
} from "./xwines-profile";

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
};

type Recorded = { table: string; filters: Record<string, unknown> };

/**
 * Minimal Supabase double. Builders are PLAIN thenables rather than promises
 * with an assigned `then`: `await` short-circuits a native promise, so an own
 * `then` on one never runs and the mock silently records nothing.
 */
function fakeSupabase(options: {
  canonical?: { xwines_wine_id: number | null } | null;
  catalog?: typeof CATALOG_ROW | null;
  match?: Array<{ wine_id: number; score: number; producer_score: number }>;
  vintages?: Array<{ vintage: number; rating_avg: number; rating_count: number }>;
}) {
  const calls: Recorded[] = [];

  function builder(table: string, result: unknown) {
    const filters: Record<string, unknown> = {};
    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return self;
      },
      order: () => self,
      limit: () => {
        calls.push({ table, filters });
        return { then: (r: (v: unknown) => unknown) => r({ data: result, error: null }) };
      },
      maybeSingle: () => {
        calls.push({ table, filters });
        return { then: (r: (v: unknown) => unknown) => r({ data: result, error: null }) };
      },
    };
    return self;
  }

  const supabase = {
    from: (table: string) => {
      if (table === "canonical_wines") return builder(table, options.canonical ?? null);
      if (table === "xwines_catalog") return builder(table, options.catalog ?? null);
      if (table === "xwines_vintage_ratings") return builder(table, options.vintages ?? []);
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: `rpc:${fn}`, filters: args as Record<string, unknown> });
      return {
        then: (r: (v: unknown) => unknown) => r({ data: options.match ?? [], error: null }),
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { supabase, calls };
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

  it("accepts a match clearing both floors", async () => {
    const { supabase } = fakeSupabase({
      match: [{ wine_id: 174177, score: 0.94, producer_score: 1 }],
      catalog: CATALOG_ROW,
    });
    const profile = await resolveXWinesProfile({ supabase, ...base });
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
      match: [{ wine_id: 999, score: 0.667, producer_score: 0.444 }],
      catalog: CATALOG_ROW,
    });
    expect(
      await resolveXWinesProfile({ supabase, ...base, producer: "Bodegas Muga", name: "Reserva" }),
    ).toBeNull();
  });

  it("rejects a match below the blended score floor even with a perfect producer", async () => {
    const { supabase } = fakeSupabase({
      match: [{ wine_id: 999, score: 0.462, producer_score: 1 }],
      catalog: CATALOG_ROW,
    });
    expect(await resolveXWinesProfile({ supabase, ...base })).toBeNull();
  });

  it("holds the floors at the documented values", async () => {
    // Exactly-at-floor must pass; a hair under must not. Pins the boundary so a
    // later loosening is a deliberate edit, not a drift.
    const atFloor = fakeSupabase({
      match: [{ wine_id: 174177, score: XWINES_SCORE_FLOOR, producer_score: XWINES_PRODUCER_FLOOR }],
      catalog: CATALOG_ROW,
    });
    expect(await resolveXWinesProfile({ supabase: atFloor.supabase, ...base })).not.toBeNull();

    const underScore = fakeSupabase({
      match: [
        { wine_id: 174177, score: XWINES_SCORE_FLOOR - 0.001, producer_score: 1 },
      ],
      catalog: CATALOG_ROW,
    });
    expect(await resolveXWinesProfile({ supabase: underScore.supabase, ...base })).toBeNull();

    const underProducer = fakeSupabase({
      match: [
        { wine_id: 174177, score: 1, producer_score: XWINES_PRODUCER_FLOOR - 0.001 },
      ],
      catalog: CATALOG_ROW,
    });
    expect(await resolveXWinesProfile({ supabase: underProducer.supabase, ...base })).toBeNull();
  });

  it("returns null when the matcher finds nothing", async () => {
    const { supabase } = fakeSupabase({ match: [] });
    expect(await resolveXWinesProfile({ supabase, ...base })).toBeNull();
  });

  it("does not call the matcher without a producer to corroborate against", async () => {
    const { supabase, calls } = fakeSupabase({ match: [] });
    expect(await resolveXWinesProfile({ supabase, ...base, producer: null })).toBeNull();
    expect(await resolveXWinesProfile({ supabase, ...base, producer: "   " })).toBeNull();
    expect(calls.filter((c) => c.table === "rpc:match_xwines")).toHaveLength(0);
  });
});

describe("resolveXWinesProfile — explicit link", () => {
  it("prefers an explicit canonical link and never runs the matcher", async () => {
    const { supabase, calls } = fakeSupabase({
      canonical: { xwines_wine_id: 174177 },
      catalog: CATALOG_ROW,
    });
    const profile = await resolveXWinesProfile({
      supabase,
      canonicalWineId: "c-1",
      producer: "Penfolds",
      name: "Koonunga Hill",
    });
    expect(profile!.provenance).toBe("linked");
    expect(profile!.matchScore).toBeNull();
    expect(calls.filter((c) => c.table === "rpc:match_xwines")).toHaveLength(0);
  });

  it("falls back to matching when the canonical row carries no link", async () => {
    const { supabase, calls } = fakeSupabase({
      canonical: { xwines_wine_id: null },
      match: [{ wine_id: 174177, score: 0.9, producer_score: 1 }],
      catalog: CATALOG_ROW,
    });
    const profile = await resolveXWinesProfile({
      supabase,
      canonicalWineId: "c-1",
      producer: "Penfolds",
      name: "Koonunga Hill",
    });
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
    const rows = await fetchVintageRatings(supabase, 174177);
    expect(rows.map((r) => r.vintage)).toEqual([2019, 2017, 2015]);
  });

  it("returns an empty list when the wine has no rated vintages", async () => {
    const { supabase } = fakeSupabase({ vintages: [] });
    expect(await fetchVintageRatings(supabase, 1)).toEqual([]);
  });
});
