import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * POST /api/wines/enrich tests (BND-031 + BND-039 + BND-261 + BND-262).
 *
 * The route ships enrichments to the `enrich_wines_batch` RPC in a single
 * round-trip. BND-039 added:
 *   • new metadata fields (peak_year, rating_source, review_excerpt)
 *   • LWIN catalog fallback for wines the rule engine misses
 *
 * BND-261 added enrichment_metadata per wine in the payload.
 *
 * BND-262's batched Claude tier has been REMOVED. Its only outputs were a
 * drink window, a peak year and a "tasting-note style sentence" — values with
 * no source, written under rating_source = 'claude_inference'. A wine the rule
 * engine cannot place now falls to the LWIN catalog instead.
 *
 * Tests pin:
 *   1. Auth: 401 skips everything
 *   2. Fetch error: 500, no RPC call
 *   3. Happy path: rule-engine matches include enrichment_metadata
 *   4. Empty payload (no wines match): no RPC
 *   5. RPC error → 500 with no LWIN fallback attempted
 *   6. A rule-engine miss reaches the LWIN catalog and never an inference tier
 *   7. The rule engine's successes are written even when the misses find nothing
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
  producer: string;
  name: string;
  varietal: string | null;
  region: string | null;
  country: string | null;
  vintage: number | null;
};

type FromResult = { data: Wine[] | { id: string }[] | null; error: unknown };

// Default rule-engine miss shape — used by the LWIN-fallback tests.
const RULE_MISS = {
  drinkWindowStart: null,
  drinkWindowEnd: null,
  peakYear: null,
  ratingSource: null,
  reviewExcerpt: null,
  servingTempMin: null,
  servingTempMax: null,
  servingTempLabel: null,
};

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

  it("403s when role is staff (BND-039 — enrichment burns Anthropic spend; owner+manager only)", async () => {
    const { supabase } = buildSupabase({
      winesResult: { data: [], error: null },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-1",
      role: "staff",
    });
    const res = await POST();
    expect(res.status).toBe(403);
    expect(mockEnrichWine).not.toHaveBeenCalled();
  });

  it("500s on wines fetch error without calling RPC", async () => {
    const { supabase, rpc } = buildSupabase({
      winesResult: { data: null, error: { message: "DB down" } },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });
    const res = await POST();
    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("includes enrichment_metadata in rule-engine payload (BND-261)", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "Domaine X", name: "Pinot", varietal: "Pinot Noir", region: "Burgundy", country: "FR", vintage: 2019 },
      { id: "w-2", producer: "Obscure Co", name: "Mystery", varietal: "Obscure Grape", region: "Nowhere", country: null, vintage: null },
      { id: "w-3", producer: "Domaine Y", name: "Chard", varietal: "Chardonnay", region: "Burgundy", country: "FR", vintage: 2020 },
    ];
    mockEnrichWine
      .mockReturnValueOnce({
        drinkWindowStart: 2021, drinkWindowEnd: 2035, peakYear: 2028, ratingSource: "rule_engine",
        reviewExcerpt: null, servingTempMin: 14, servingTempMax: 16, servingTempLabel: "cellar",
      })
      .mockReturnValueOnce(RULE_MISS)
      .mockReturnValueOnce({
        drinkWindowStart: 2022, drinkWindowEnd: 2030, peakYear: 2026, ratingSource: "rule_engine",
        reviewExcerpt: null, servingTempMin: 10, servingTempMax: 12, servingTempLabel: "chilled",
      });

    // BND-262: batch Claude returns all nulls (default mock)

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 2, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.enriched).toBe(2);
    expect(body.ruleEnrichedCount).toBe(2);
    // Always zero now: the Claude inference tier is gone. The counter is
    // retained in the response shape so removing it is not an API break.
    expect(body.claudeAttemptedCount).toBe(0);
    expect(body.claudeEnrichedCount).toBe(0);

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    expect(enrichCall).toBeDefined();
    const args = enrichCall!.args as { p_restaurant_id: string; p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_restaurant_id).toBe("r-1");
    expect(args.p_enrichments).toHaveLength(2);
    expect(args.p_enrichments[0].id).toBe("w-1");
    expect(args.p_enrichments[0].peak_year).toBe(2028);
    expect(args.p_enrichments[0].rating_source).toBe("rule_engine");
    expect(args.p_enrichments[0].review_excerpt).toBeNull();
    const meta0 = args.p_enrichments[0].enrichment_metadata as Record<string, unknown>;
    expect(meta0).toBeDefined();
    expect(meta0.source).toBe("rule_engine");
    expect(args.p_enrichments[1].id).toBe("w-3");
  });

  it("sends a rule-engine miss to the LWIN catalog, never to a paid inference tier", async () => {
    // BND-262 removed. The Claude tier's only outputs were a drink window, a
    // peak year and a "tasting-note style sentence" -- values with no source,
    // written under rating_source = 'claude_inference' and rendered on the
    // wine page as though they were sourced. A wine the rule engine cannot
    // place now falls straight to the LWIN catalog, which is free and derived
    // from a real reference.
    const wines: Wine[] = [
      { id: "w-1", producer: "Krug", name: "Grande Cuvee", varietal: "Champagne Blend", region: "Champagne", country: "FR", vintage: 2008 },
      { id: "w-2", producer: "Chateau X", name: "Rare Bordeaux", varietal: "Cabernet Blend", region: "Bordeaux", country: "FR", vintage: 2010 },
    ];
    mockEnrichWine.mockReturnValueOnce(RULE_MISS).mockReturnValueOnce(RULE_MISS);

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 0, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ruleEnrichedCount).toBe(0);
    expect(body.claudeAttemptedCount).toBe(0);
    expect(body.claudeEnrichedCount).toBe(0);

    // The LWIN fallback is the tier that now sees them.
    expect(rpcCalls.some((c) => c.fn === "match_lwin_batch")).toBe(true);

    // And nothing anywhere claims an inference source.
    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    const rows = (enrichCall?.args as { p_enrichments?: Array<Record<string, unknown>> })?.p_enrichments ?? [];
    for (const row of rows) {
      expect(row.rating_source).not.toBe("claude_inference");
    }
  });

  it("writes the rule engine's successes even when the misses find nothing", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "X", name: "Pinot", varietal: "Pinot Noir", region: "Burgundy", country: "FR", vintage: 2019 },
      { id: "w-2", producer: "Y", name: "Mystery", varietal: "Obscure", region: null, country: null, vintage: 2020 },
      { id: "w-3", producer: "Z", name: "Other", varietal: "Obscure", region: null, country: null, vintage: 2020 },
    ];
    mockEnrichWine
      .mockReturnValueOnce({
        drinkWindowStart: 2022, drinkWindowEnd: 2030, peakYear: 2026, ratingSource: "rule_engine",
        reviewExcerpt: null, servingTempMin: 14, servingTempMax: 16, servingTempLabel: "cellar",
      })
      .mockReturnValueOnce(RULE_MISS)
      .mockReturnValueOnce(RULE_MISS);

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 1, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();

    // One partial failure must not cost the wine the rule engine did place.
    expect(body.ruleEnrichedCount).toBe(1);
    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    const args = enrichCall!.args as { p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_enrichments[0].id).toBe("w-1");
    expect(args.p_enrichments[0].rating_source).toBe("rule_engine");
  });

  it("skips the RPC entirely when no wine matches any rule and Claude returns all nulls", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "X", name: "Mystery", varietal: "Obscure", region: "Nowhere", country: null, vintage: null },
    ];
    mockEnrichWine.mockReturnValue(RULE_MISS);
    // Default batch mock returns [] (no wines enriched)

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enriched).toBe(0);
    expect(rpcCalls.find((c) => c.fn === "enrich_wines_batch")).toBeUndefined();
  });

  it("surfaces RPC errors as 500 without attempting the LWIN fallback", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "X", name: "Pinot", varietal: "Pinot Noir", region: "Burgundy", country: "FR", vintage: 2019 },
    ];
    mockEnrichWine.mockReturnValue({
      drinkWindowStart: 2021, drinkWindowEnd: 2035, peakYear: 2028, ratingSource: "rule_engine",
      reviewExcerpt: null, servingTempMin: 14, servingTempMax: 16, servingTempLabel: "cellar",
    });

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: null, error: { message: "constraint" } },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(500);
    expect(rpcCalls.filter((c) => c.fn === "enrich_wines_batch")).toHaveLength(1);
    expect(rpcCalls.find((c) => c.fn === "match_lwin_batch")).toBeUndefined();
  });
});
