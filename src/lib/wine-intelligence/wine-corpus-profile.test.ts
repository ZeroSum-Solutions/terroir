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

const blank = { canonicalWineId: null, producer: "", name: "Benjamin Leroux Vosne-Romanée" };


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
    // A wine that HAS a producer never has one RECOVERED for it: digging a
    // second, made-up producer out of its name would be a guess layered on a
    // rejection, and that is still refused — the prefix lookup (the only
    // `.in()` this module issues) must not happen.
    //
    // What DOES now happen is the image tier, which is a different question:
    // it re-asks the RPC about the producer the row already states, and offers
    // a captioned picture if that clears the producer floor. Here it does not,
    // so the answer is unchanged. Two RPC calls, one conclusion.
    const { supabase, calls } = fakeSupabase({ match: [] });
    const read = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: null,
      producer: "Nobody At All",
      name: "Some Cuvée",
    });
    expect(read).toEqual({ status: "ok", value: null });
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
