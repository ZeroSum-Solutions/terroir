import { describe, expect, it, vi } from "vitest";
import { resolveWineCorpusProfile } from "./wine-corpus-profile";
import { XWINES_PRODUCER_FLOOR } from "./xwines-profile";
import {
  CATALOG_ROW,
  fakeSupabase,
  producerOnlyHit,
  strictHit,
} from "@/test/fixtures/wine-corpus-double";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

describe("resolveWineCorpusProfile — the name the matcher is actually given", () => {
  /**
   * Measured against the 1,064 production wines that HAVE a producer, once the
   * corpus was finally loaded there (2026-08-31, 300-wine sample):
   *
   *   PROFILE_ACCEPT, name as stored        23  (7.7%)
   *   PROFILE_ACCEPT, producer prefix cut   63  (21.0%)
   *
   * The importer writes `name` as "<producer>, <varietal>, <region>", so the
   * cuvée floor was comparing "Willis Hall, Cabernet Franc, Columbia Valley"
   * against the corpus's "Cabernet Franc" and scoring 0.333 against a 0.64
   * floor — while the producer scored a clean 1.000. Nothing was wrong with
   * the floor; it was being asked about the wrong string.
   */
  it("strips the producer prefix before asking the matcher about the cuvée", async () => {
    const { supabase, calls } = fakeSupabase({ match: [strictHit], catalog: CATALOG_ROW });
    await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Willis Hall",
      name: "Willis Hall, Cabernet Franc, Columbia Valley",
    });
    const rpc = calls.find((call) => call.table === "rpc:match_xwines");
    expect(rpc?.args).toMatchObject({
      p_producer: "Willis Hall",
      p_name: "Cabernet Franc, Columbia Valley",
    });
  });

  it("leaves a name that does not begin with its producer untouched", async () => {
    const { supabase, calls } = fakeSupabase({ match: [strictHit], catalog: CATALOG_ROW });
    await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Benjamin Leroux",
      name: "Vosne-Romanée",
    });
    const rpc = calls.find((call) => call.table === "rpc:match_xwines");
    expect(rpc?.args).toMatchObject({ p_name: "Vosne-Romanée" });
  });
});

describe("resolveWineCorpusProfile — IMAGE_ACCEPT for a stated producer", () => {
  /**
   * The image tier used to be reachable only by a row whose producer had to be
   * RECOVERED from its name, and its 2-word floor exists to protect that
   * recovery. A row that STATES its producer needs no recovery and so is not
   * exposed to that risk: the producer is the row's own, and the RPC is still
   * required to agree at XWINES_PRODUCER_FLOOR.
   *
   * Same 300-wine sample: 60 further wines (20.0%) clear the producer floor
   * with a cuvée that does not. They were being shown nothing at all.
   */
  it("offers a producer-level picture when the cuvée floor is missed", async () => {
    const { supabase } = fakeSupabase({
      match: [producerOnlyHit],
      catalog: CATALOG_ROW,
    });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Benjamin Leroux",
      name: "Some Other Cuvée",
    });
    expect(read).toMatchObject({
      status: "ok",
      value: { provenance: "producer-matched", image: { kind: "producer" } },
    });
  });

  it("claims no taste fact at that confidence", async () => {
    const { supabase } = fakeSupabase({ match: [producerOnlyHit], catalog: CATALOG_ROW });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Benjamin Leroux",
      name: "Some Other Cuvée",
    });
    // CATALOG_ROW is full of taste data. None of it may travel on this tier.
    expect(read).toMatchObject({
      status: "ok",
      value: {
        body: null,
        acidity: null,
        grapes: [],
        pairings: [],
        regionName: null,
        country: null,
      },
    });
  });

  it("still shows nothing when even the producer floor is missed", async () => {
    const { supabase } = fakeSupabase({
      match: [{ wine_id: 1, score: 0.4, producer_score: XWINES_PRODUCER_FLOOR - 0.01, name_score: 0.2 }],
      catalog: CATALOG_ROW,
    });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Nobody At All",
      name: "Some Cuvée",
    });
    expect(read).toEqual({ status: "ok", value: null });
  });
});
