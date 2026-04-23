import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * POST /api/wines/enrich tests (BND-031).
 *
 * The route now ships enrichments to the `enrich_wines_batch` RPC in
 * a single round-trip instead of firing N individual UPDATEs via
 * Promise.all. Tests pin:
 *   1. Auth: 401 skips everything
 *   2. Fetch error: 500, no RPC call
 *   3. Happy path: wines without a matching rule are filtered from the
 *      payload; RPC receives only the enriched rows
 *   4. Empty payload (no wines match any rule): no RPC call, enriched=0
 *   5. RPC error → 500 with no lwin fallback being attempted
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockEnrichWine = vi.fn();
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: (...args: unknown[]) => mockEnrichWine(...args),
}));

const { POST } = await import("./route");

type Wine = {
  id: string;
  varietal: string;
  region: string;
  country: string | null;
  vintage: number | null;
};

type FromResult = { data: Wine[] | { id: string }[] | null; error: unknown };

function buildSupabase(opts: {
  winesResult: FromResult;
  unmatchedResult?: FromResult;
  rpcEnrichResult?: { data: number | null; error: unknown };
  rpcLwinResult?: { data: unknown[]; error: unknown };
}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const rpc = vi.fn((fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (fn === "enrich_wines_batch") {
      return Promise.resolve(
        opts.rpcEnrichResult ?? { data: 0, error: null },
      );
    }
    if (fn === "match_lwin_batch") {
      return Promise.resolve(
        opts.rpcLwinResult ?? { data: [], error: null },
      );
    }
    return Promise.resolve({ data: null, error: null });
  });

  // ARCH-021: enrich fetch is now
  //   .select().eq().or(...).limit(...)
  // and the LWIN fetch is
  //   .select().eq().is(...).limit(...)
  // so the mock chain mirrors both shapes with a terminal `.limit()`
  // that thenables-through to the configured result.
  let winesFetchCount = 0;
  const limitForWines = () => ({
    then: (resolve: (v: FromResult) => void) => {
      winesFetchCount += 1;
      resolve(
        winesFetchCount === 1
          ? opts.winesResult
          : (opts.unmatchedResult ?? { data: [], error: null }),
      );
    },
  });
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        or: () => ({ limit: () => limitForWines() }),
        is: () => ({ limit: () => limitForWines() }),
      }),
    }),
  }));

  return { supabase: { from, rpc }, rpc, rpcCalls, from };
}

describe("POST /api/wines/enrich", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when requireMembership returns a NextResponse", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mockEnrichWine).not.toHaveBeenCalled();
  });

  it("500s on wines fetch error without calling RPC", async () => {
    const { supabase, rpc } = buildSupabase({
      winesResult: { data: null, error: { message: "DB down" } },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await POST();
    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("filters out wines with no matching rule and sends only enriched rows in one batch", async () => {
    const wines: Wine[] = [
      { id: "w-1", varietal: "Pinot Noir", region: "Burgundy", country: "FR", vintage: 2019 },
      { id: "w-2", varietal: "Obscure Grape", region: "Nowhere", country: null, vintage: null },
      { id: "w-3", varietal: "Chardonnay", region: "Burgundy", country: "FR", vintage: 2020 },
    ];
    mockEnrichWine
      .mockReturnValueOnce({ drinkWindowStart: 2021, drinkWindowEnd: 2035, servingTempMin: 14, servingTempMax: 16, servingTempLabel: "cellar" })
      .mockReturnValueOnce({ drinkWindowStart: null, drinkWindowEnd: null, servingTempMin: null, servingTempMax: null, servingTempLabel: null })
      .mockReturnValueOnce({ drinkWindowStart: 2022, drinkWindowEnd: 2030, servingTempMin: 10, servingTempMax: 12, servingTempLabel: "chilled" });

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 2, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.enriched).toBe(2);

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    expect(enrichCall).toBeDefined();
    const args = enrichCall!.args as { p_restaurant_id: string; p_enrichments: unknown[] };
    expect(args.p_restaurant_id).toBe("r-1");
    expect(args.p_enrichments).toHaveLength(2);
    expect((args.p_enrichments[0] as { id: string }).id).toBe("w-1");
    expect((args.p_enrichments[1] as { id: string }).id).toBe("w-3");
  });

  it("skips the RPC entirely when no wine matches any rule", async () => {
    const wines: Wine[] = [
      { id: "w-1", varietal: "Obscure", region: "Nowhere", country: null, vintage: null },
    ];
    mockEnrichWine.mockReturnValue({
      drinkWindowStart: null,
      drinkWindowEnd: null,
      servingTempMin: null,
      servingTempMax: null,
      servingTempLabel: null,
    });

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enriched).toBe(0);
    expect(rpcCalls.find((c) => c.fn === "enrich_wines_batch")).toBeUndefined();
  });

  it("surfaces RPC errors as 500 without attempting the lwin fallback", async () => {
    const wines: Wine[] = [
      { id: "w-1", varietal: "Pinot Noir", region: "Burgundy", country: "FR", vintage: 2019 },
    ];
    mockEnrichWine.mockReturnValue({
      drinkWindowStart: 2021,
      drinkWindowEnd: 2035,
      servingTempMin: 14,
      servingTempMax: 16,
      servingTempLabel: "cellar",
    });

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: null, error: { message: "constraint" } },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST();
    expect(res.status).toBe(500);
    // enrich RPC was called exactly once; lwin RPC was NOT called
    expect(rpcCalls.filter((c) => c.fn === "enrich_wines_batch")).toHaveLength(1);
    expect(rpcCalls.find((c) => c.fn === "match_lwin_batch")).toBeUndefined();
  });
});
