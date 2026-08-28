import { describe, it, expect, vi } from "vitest";
import { buildLwinQueryVariants, matchLwinBulk, type LwinMatchQuery } from "./lwin-matching";
import { LWIN_MATCH_BATCH_SIZE } from "./constants";

describe("buildLwinQueryVariants", () => {
  it("returns exactly the one classic query for rows with a real producer", () => {
    expect(buildLwinQueryVariants("Domaine A", "Richebourg Grand Cru")).toEqual([
      { producer: "Domaine A", name: "Richebourg Grand Cru" },
    ]);
  });

  it("returns only the full-name query for a producer-less 2-token name", () => {
    expect(buildLwinQueryVariants("", "La Pianelle")).toEqual([
      { producer: "La Pianelle", name: "La Pianelle" },
    ]);
  });

  it("adds a first-2-token producer variant at 3 tokens", () => {
    expect(buildLwinQueryVariants("", "Vietti Barolo Lazzarito")).toEqual([
      { producer: "Vietti Barolo Lazzarito", name: "Vietti Barolo Lazzarito" },
      { producer: "Vietti Barolo", name: "Vietti Barolo Lazzarito" },
    ]);
  });

  it("adds first-2 and first-3 token producer variants at 4+ tokens", () => {
    expect(
      buildLwinQueryVariants("", "Poggio di Sotto Brunello di Montalcino"),
    ).toEqual([
      {
        producer: "Poggio di Sotto Brunello di Montalcino",
        name: "Poggio di Sotto Brunello di Montalcino",
      },
      {
        producer: "Poggio di",
        name: "Poggio di Sotto Brunello di Montalcino",
      },
      {
        producer: "Poggio di Sotto",
        name: "Poggio di Sotto Brunello di Montalcino",
      },
    ]);
  });

  it("token-splits on runs of whitespace without empty tokens", () => {
    expect(buildLwinQueryVariants("", "  Le  Ragnaie   Brunello  ")).toEqual([
      { producer: "  Le  Ragnaie   Brunello  ", name: "  Le  Ragnaie   Brunello  " },
      { producer: "Le Ragnaie", name: "  Le  Ragnaie   Brunello  " },
    ]);
  });
});

describe("matchLwinBulk", () => {
  function makeSupabase(
    respond: (
      batch: LwinMatchQuery[],
    ) => Array<{ idx: number; lwin_id: string | null; score: number | null; display_name?: string | null }>,
  ) {
    const rpc = vi.fn().mockImplementation((_fn: string, args: { p_queries: LwinMatchQuery[] }) =>
      Promise.resolve({ data: respond(args.p_queries), error: null }),
    );
    return { rpc } as unknown as Parameters<typeof matchLwinBulk>[0] & { rpc: typeof rpc };
  }

  it("splits queries into batches of LWIN_MATCH_BATCH_SIZE and merges every chunk's results", async () => {
    const total = 2 * LWIN_MATCH_BATCH_SIZE + 50;
    const queries: LwinMatchQuery[] = Array.from({ length: total }, (_, i) => ({
      idx: i,
      producer: `P${i}`,
      name: `N${i}`,
    }));
    // Every chunk matches its own FIRST query — so a dropped or
    // mis-merged chunk loses a specific, identifiable idx.
    const supabase = makeSupabase((batch) => [
      { idx: batch[0].idx, lwin_id: `LWIN-${batch[0].idx}`, score: 0.7, display_name: `Wine ${batch[0].idx}` },
    ]);
    const result = await matchLwinBulk(supabase, queries);
    expect(supabase.rpc).toHaveBeenCalledTimes(3);
    expect(supabase.rpc.mock.calls.map((c) => (c[1] as { p_queries: LwinMatchQuery[] }).p_queries.length)).toEqual([
      LWIN_MATCH_BATCH_SIZE,
      LWIN_MATCH_BATCH_SIZE,
      50,
    ]);
    expect(result.get(0)).toEqual({ lwinId: "LWIN-0", score: 0.7, displayName: "Wine 0" });
    expect(result.get(LWIN_MATCH_BATCH_SIZE)).toEqual({
      lwinId: `LWIN-${LWIN_MATCH_BATCH_SIZE}`,
      score: 0.7,
      displayName: `Wine ${LWIN_MATCH_BATCH_SIZE}`,
    });
    expect(result.get(2 * LWIN_MATCH_BATCH_SIZE)).toEqual({
      lwinId: `LWIN-${2 * LWIN_MATCH_BATCH_SIZE}`,
      score: 0.7,
      displayName: `Wine ${2 * LWIN_MATCH_BATCH_SIZE}`,
    });
    expect(result.size).toBe(3);
  });

  it("rejects when any chunk's RPC errors", async () => {
    const queries: LwinMatchQuery[] = Array.from({ length: LWIN_MATCH_BATCH_SIZE + 1 }, (_, i) => ({
      idx: i,
      producer: `P${i}`,
      name: `N${i}`,
    }));
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("boom") });
    const supabase = { rpc } as unknown as Parameters<typeof matchLwinBulk>[0];
    await expect(matchLwinBulk(supabase, queries)).rejects.toThrow("boom");
  });

  it("treats a null score on a matched row as 0", async () => {
    const supabase = makeSupabase(() => [{ idx: 0, lwin_id: "LWIN-NULLSCORE", score: null }]);
    const result = await matchLwinBulk(supabase, [{ idx: 0, producer: "P", name: "N" }]);
    expect(result.get(0)).toEqual({ lwinId: "LWIN-NULLSCORE", score: 0, displayName: null });
  });

  // BLOCK 2 (round-13 fix) — match_lwin_bulk (0076_csv_import_batches.sql)
  // already returns display_name with each winning candidate; this proves
  // matchLwinBulk carries it through instead of discarding it (the exact
  // gap preview-service.ts's own separate lwin_catalog lookup used to
  // paper over).
  it("carries match_lwin_bulk's own display_name through into the result", async () => {
    const supabase = makeSupabase(() => [
      { idx: 0, lwin_id: "LWIN001", score: 0.9, display_name: "Domaine A Cuvee One 2020" },
    ]);
    const result = await matchLwinBulk(supabase, [{ idx: 0, producer: "Domaine A", name: "Cuvee One" }]);
    expect(result.get(0)).toEqual({ lwinId: "LWIN001", score: 0.9, displayName: "Domaine A Cuvee One 2020" });
  });

  it("degrades display_name to null when match_lwin_bulk itself returns a null one", async () => {
    const supabase = makeSupabase(() => [{ idx: 0, lwin_id: "LWIN001", score: 0.9, display_name: null }]);
    const result = await matchLwinBulk(supabase, [{ idx: 0, producer: "Domaine A", name: "Cuvee One" }]);
    expect(result.get(0)).toEqual({ lwinId: "LWIN001", score: 0.9, displayName: null });
  });
});
