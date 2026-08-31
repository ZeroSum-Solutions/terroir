import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { resolveWineCorpusProfile } from "./wine-corpus-profile";
import { XWINES_PRODUCER_FLOOR } from "./xwines-profile";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const CATALOG_ROW = {
  wine_id: 119230,
  name: "Vosne-Romanee",
  winery_name: "Benjamin Leroux",
  type: "Red",
  elaborate: "Varietal/100%",
  grapes: ["Pinot Noir"],
  harmonize: ["Beef", "Poultry"],
  abv: 13.0,
  body: "Medium-bodied",
  acidity: "High",
  region_name: "Vosne-Romanée",
  country: "France",
  website: null,
  vintages: [2019, 2018],
  has_non_vintage: false,
  rating_avg: 4.1,
  rating_count: 120,
  image_url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/xwines/119230.jpeg",
  image_kind: "label",
  image_source: "xwines",
  image_credit: null,
};

type MatchRow = {
  wine_id: number;
  score: number;
  producer_score: number;
  name_score: number;
};

type Call = { table: string; values?: unknown; args?: unknown };

/**
 * PostgREST + RPC double covering the three tables this module touches. Plain
 * thenables, per xwines-profile.test.ts's note about `await` short-circuiting
 * native promises.
 */
function fakeSupabase(options: {
  /** What the producer-prefix lookup finds in `winery_name`. */
  prefixHit?: string | null;
  /** What match_xwines returns, in order. */
  match?: MatchRow[];
  catalog?: Record<string, unknown> | null;
  canonical?: { xwines_wine_id: number | null } | null;
  fail?: "prefix" | "match" | "catalog";
}) {
  const calls: Call[] = [];
  const error = { message: "boom" };
  const supabase = {
    from: (table: string) => {
      const call: Call = { table };
      // The prefix lookup is the only `.in()` on xwines_catalog; a `.eq()` on
      // the same table is the image tier reading one row back.
      let isPrefixLookup = false;
      const settle = () => {
        calls.push(call);
        if (table === "canonical_wines") {
          return thenable({ data: options.canonical ?? null, error: null });
        }
        if (isPrefixLookup) {
          if (options.fail === "prefix") return thenable({ data: null, error });
          const winery = options.prefixHit ?? null;
          return thenable({
            data: winery === null ? null : { winery_name: winery },
            error: null,
          });
        }
        if (options.fail === "catalog") return thenable({ data: null, error });
        return thenable({ data: options.catalog ?? null, error: null });
      };
      const self = {
        select: () => self,
        eq: () => self,
        in: (column: string, values: unknown) => {
          isPrefixLookup = true;
          call.values = values;
          return self;
        },
        order: () => self,
        limit: () => self,
        maybeSingle: settle,
      };
      return self;
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: `rpc:${fn}`, args });
      if (options.fail === "match") return thenable({ data: null, error });
      return thenable({ data: options.match ?? [], error: null });
    },
  } as unknown as SupabaseClient<Database>;
  return { supabase, calls };
}

function thenable(payload: unknown) {
  return { then: (resolve: (value: unknown) => unknown) => resolve(payload) };
}

const blank = { canonicalWineId: null, producer: "", name: "Benjamin Leroux Vosne-Romanée" };

const strictHit: MatchRow = {
  wine_id: 119230,
  score: 0.95,
  producer_score: 1,
  name_score: 0.95,
};

/** Right winery, cuvée nowhere near — clears the producer floor and nothing else. */
const producerOnlyHit: MatchRow = {
  wine_id: 119230,
  score: 0.75,
  producer_score: 1,
  name_score: 0.35,
};

describe("resolveWineCorpusProfile — a row that already has a producer", () => {
  it("is answered by the existing rule alone, with no recovery attempted", async () => {
    const { supabase, calls } = fakeSupabase({ match: [strictHit], catalog: CATALOG_ROW });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Benjamin Leroux",
      name: "Vosne-Romanée",
    });
    expect(read).toMatchObject({ status: "ok", value: { provenance: "matched" } });
    expect(calls.some((call) => call.values !== undefined)).toBe(false);
  });

  it("does not go looking in the name when the producer it has failed to match", async () => {
    // A wine that HAS a producer has been answered. Digging a second, made-up
    // producer out of its name would be a guess layered on a rejection.
    const { supabase, calls } = fakeSupabase({ match: [] });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Nobody At All",
      name: "Some Cuvée",
    });
    expect(read).toEqual({ status: "ok", value: null });
    expect(calls.filter((call) => call.table === "rpc:match_xwines")).toHaveLength(1);
    expect(calls.some((call) => call.values !== undefined)).toBe(false);
  });
});

describe("resolveWineCorpusProfile — PROFILE_ACCEPT via a recovered producer", () => {
  it("re-runs the unchanged strict rule against the producer found in the name", async () => {
    const { supabase, calls } = fakeSupabase({
      prefixHit: "Benjamin Leroux",
      match: [strictHit],
      catalog: CATALOG_ROW,
    });
    const read = await resolveWineCorpusProfile({ supabase, ...blank });
    expect(read.status).toBe("ok");
    const profile = (read as { value: NonNullable<unknown> }).value as {
      provenance: string;
      matchedWinery: string;
      body: { label: string } | null;
      grapes: string[];
      image: { kind: string } | null;
    };
    // A strict match is a full profile: the taste fields come with it.
    expect(profile.provenance).toBe("matched");
    expect(profile.matchedWinery).toBe("Benjamin Leroux");
    expect(profile.body?.label).toBe("Medium-bodied");
    expect(profile.grapes).toEqual(["Pinot Noir"]);
    expect(profile.image?.kind).toBe("label");
    // The producer and cuvée the RPC was asked about are the recovered split,
    // not the raw name — that split is the entire point.
    const rpc = calls.find((call) => call.table === "rpc:match_xwines");
    expect(rpc?.args).toEqual({
      p_producer: "Benjamin Leroux",
      p_name: "Vosne-Romanée",
    });
  });

  it("gives up when the name starts with no winery the corpus knows", async () => {
    const { supabase, calls } = fakeSupabase({ prefixHit: null });
    expect(await resolveWineCorpusProfile({ supabase, ...blank })).toEqual({
      status: "ok",
      value: null,
    });
    expect(calls.filter((call) => call.table === "rpc:match_xwines")).toHaveLength(0);
  });
});

describe("resolveWineCorpusProfile — IMAGE_ACCEPT", () => {
  it("returns a picture and NOTHING else when only the producer is certain", async () => {
    const { supabase } = fakeSupabase({
      prefixHit: "Benjamin Leroux",
      match: [producerOnlyHit],
      catalog: CATALOG_ROW,
    });
    const read = await resolveWineCorpusProfile({ supabase, ...blank });
    expect(read.status).toBe("ok");
    const profile = (read as { value: Record<string, unknown> }).value;
    expect(profile.provenance).toBe("producer-matched");
    expect(profile.image).toMatchObject({ url: CATALOG_ROW.image_url });
    // Everything a producer-level match is not evidence for.
    expect(profile.body).toBeNull();
    expect(profile.acidity).toBeNull();
    expect(profile.grapes).toEqual([]);
    expect(profile.pairings).toEqual([]);
    expect(profile.abv).toBeNull();
    expect(profile.regionName).toBeNull();
    expect(profile.country).toBeNull();
    expect(profile.ratingAvg).toBeNull();
    expect(profile.ratingCount).toBe(0);
  });

  it("never presents a label as this wine's when the cuvée is unconfirmed", async () => {
    // CATALOG_ROW's own image_kind is "label" — a real photograph of a real
    // Benjamin Leroux bottle. At producer confidence it is a bottle from this
    // producer and not this cuvée, and that is what the kind has to say, or
    // CORPUS_IMAGE_NOTE captions somebody else's bottling as this label.
    const { supabase } = fakeSupabase({
      prefixHit: "Benjamin Leroux",
      match: [producerOnlyHit],
      catalog: CATALOG_ROW,
    });
    const read = await resolveWineCorpusProfile({ supabase, ...blank });
    const image = (read as { value: { image: { kind: string } } }).value.image;
    expect(image.kind).toBe("producer");
  });

  it("does not upgrade a representative picture just because the producer is right", async () => {
    const { supabase } = fakeSupabase({
      prefixHit: "Benjamin Leroux",
      match: [producerOnlyHit],
      catalog: { ...CATALOG_ROW, image_kind: "representative" },
    });
    const read = await resolveWineCorpusProfile({ supabase, ...blank });
    const image = (read as { value: { image: { kind: string } } }).value.image;
    expect(image.kind).toBe("representative");
  });

  it("refuses a one-word producer, which is where the generic-word trap lives", async () => {
    // Measured on the reconstructed negative set: a one-word prefix admits 38
    // wrong producers in 250 ('Canto Verde …' -> the corpus winery 'Canto'),
    // and this tier has no cuvée floor to catch them. See the module header.
    const { supabase, calls } = fakeSupabase({
      prefixHit: "Canto",
      match: [producerOnlyHit],
      catalog: CATALOG_ROW,
    });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "",
      name: "Canto Verde Champagne Chardonnay Lot 003",
    });
    expect(read).toEqual({ status: "ok", value: null });
    // It stops before the image tier's own RPC call rather than after it.
    expect(calls.filter((call) => call.table === "rpc:match_xwines")).toHaveLength(1);
  });

  it("still holds the producer floor the strict tier uses", async () => {
    const { supabase } = fakeSupabase({
      prefixHit: "Benjamin Leroux",
      match: [{ ...producerOnlyHit, producer_score: XWINES_PRODUCER_FLOOR - 0.01 }],
      catalog: CATALOG_ROW,
    });
    expect(await resolveWineCorpusProfile({ supabase, ...blank })).toEqual({
      status: "ok",
      value: null,
    });
  });

  it("offers nothing when the matched row has no photograph", async () => {
    const { supabase } = fakeSupabase({
      prefixHit: "Benjamin Leroux",
      match: [producerOnlyHit],
      catalog: { ...CATALOG_ROW, image_url: null, image_kind: null, image_source: null },
    });
    expect(await resolveWineCorpusProfile({ supabase, ...blank })).toEqual({
      status: "ok",
      value: null,
    });
  });
});

describe("resolveWineCorpusProfile — a corpus it could not read", () => {
  it("reports the prefix lookup failing as unavailable, not as no match", async () => {
    const { supabase } = fakeSupabase({ fail: "prefix" });
    expect(await resolveWineCorpusProfile({ supabase, ...blank })).toEqual({
      status: "unavailable",
    });
  });

  it("reports a failed match as unavailable rather than as no match", async () => {
    const { supabase } = fakeSupabase({ prefixHit: "Benjamin Leroux", fail: "match" });
    expect(await resolveWineCorpusProfile({ supabase, ...blank })).toEqual({
      status: "unavailable",
    });
  });
});
