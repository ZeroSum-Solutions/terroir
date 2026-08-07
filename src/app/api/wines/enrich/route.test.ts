import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * POST /api/wines/enrich tests (BND-031 + BND-039 + BND-261 + BND-262).
 *
 * The route ships enrichments to the `enrich_wines_batch` RPC in a single
 * round-trip. BND-039 added:
 *   • new metadata fields (peak_year, rating_source, review_excerpt)
 *   • Claude inference fallback for wines the rule engine misses
 *
 * BND-261 added enrichment_metadata per wine in the payload.
 *
 * BND-262 (feature #75): Claude calls are batched — all candidate wines
 * go in a single `enrichWinesWithClaudeBatch` call instead of one
 * `enrichWineWithClaude` call per wine.
 *
 * Tests pin:
 *   1. Auth: 401 skips everything
 *   2. Fetch error: 500, no RPC call
 *   3. Happy path: rule-engine matches include enrichment_metadata
 *   4. Empty payload (no wines match, Claude returns all nulls): no RPC
 *   5. RPC error → 500 with no LWIN fallback attempted
 *   6. Claude batch: all candidates in one call, results include
 *      enrichment_metadata with source="claude_inference"
 *   7. Claude failures return all-null, partial batch enrichment still works
 */

const mockRequireCapability = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    mockRequireCapability(...args),
}));

const mockEnrichWine = vi.fn();
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: (...args: unknown[]) => mockEnrichWine(...args),
}));

const mockEnrichWinesWithClaudeBatch = vi.fn();
vi.mock("@/lib/wine-intelligence/enrich-claude", () => ({
  enrichWinesWithClaudeBatch: (...args: unknown[]) => mockEnrichWinesWithClaudeBatch(...args),
  // Keep the single-wine export for other consumers (not used by batch.ts anymore)
  enrichWineWithClaude: () => Promise.resolve(null),
}));

const { POST } = await import("./route");

function request() {
  return new Request("http://localhost/api/wines/enrich", { method: "POST" });
}

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

// Default rule-engine miss shape — used by Claude-fallback tests.
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
    // Default batch mock: returns array of nulls (no Claude enrichment).
    mockEnrichWinesWithClaudeBatch.mockResolvedValue([]);
  });

  it("401s when requireCapability returns a NextResponse", async () => {
    mockRequireCapability.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(mockEnrichWine).not.toHaveBeenCalled();
  });

  it("403s when role is staff (BND-039 — enrichment burns Anthropic spend; owner+manager only)", async () => {
    mockRequireCapability.mockResolvedValue(
      NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    );
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(mockEnrichWine).not.toHaveBeenCalled();
    expect(mockEnrichWinesWithClaudeBatch).not.toHaveBeenCalled();
  });

  it("500s on wines fetch error without calling RPC", async () => {
    const { supabase, rpc } = buildSupabase({
      winesResult: { data: null, error: { message: "DB down" } },
    });
    mockRequireCapability.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });
    const res = await POST(request());
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
    mockRequireCapability.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.enriched).toBe(2);
    expect(body.ruleEnrichedCount).toBe(2);
    expect(body.claudeAttemptedCount).toBe(1);
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

  it("Claude batch enriches all candidates in one call (BND-262)", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "Krug", name: "Grande Cuvee", varietal: "Champagne Blend", region: "Champagne", country: "FR", vintage: 2008 },
      { id: "w-2", producer: "Chateau X", name: "Rare Bordeaux", varietal: "Cabernet Blend", region: "Bordeaux", country: "FR", vintage: 2010 },
    ];
    // Both wines miss the rule engine
    mockEnrichWine
      .mockReturnValueOnce(RULE_MISS)
      .mockReturnValueOnce(RULE_MISS);

    // BND-262: single batched call with 2 results
    mockEnrichWinesWithClaudeBatch.mockResolvedValueOnce([
      {
        drinkWindowStart: 2018,
        drinkWindowEnd: 2032,
        peakYear: 2025,
        ratingSource: "claude_inference",
        reviewExcerpt: "Krug's flagship — drink with patience.",
        servingTempMin: null,
        servingTempMax: null,
        servingTempLabel: null,
        decantMinutes: 30,
      },
      {
        drinkWindowStart: 2020,
        drinkWindowEnd: 2045,
        peakYear: 2035,
        ratingSource: "claude_inference",
        reviewExcerpt: "Structured and powerful, needs time.",
        servingTempMin: null,
        servingTempMax: null,
        servingTempLabel: null,
      },
    ]);

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 2, error: null },
    });
    mockRequireCapability.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleEnrichedCount).toBe(0);
    expect(body.claudeAttemptedCount).toBe(2);
    expect(body.claudeEnrichedCount).toBe(2);

    // Verify a single Claude batch call was made
    expect(mockEnrichWinesWithClaudeBatch).toHaveBeenCalledTimes(1);
    const batchArg = mockEnrichWinesWithClaudeBatch.mock.calls[0][0] as Wine[];
    expect(batchArg).toHaveLength(2);
    expect(batchArg[0].producer).toBe("Krug");
    expect(batchArg[1].producer).toBe("Chateau X");

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    const args = enrichCall!.args as { p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_enrichments).toHaveLength(2);
    expect(args.p_enrichments[0].id).toBe("w-1");
    expect(args.p_enrichments[0].rating_source).toBe("claude_inference");
    expect(args.p_enrichments[0].decant_minutes).toBe(30);
    expect(args.p_enrichments[1].id).toBe("w-2");

    // Both should have enrichment_metadata with source=claude_inference
    for (const row of args.p_enrichments) {
      const meta = row.enrichment_metadata as Record<string, unknown>;
      expect(meta.source).toBe("claude_inference");
      expect(meta.enriched_at).toEqual(expect.any(String));
    }
  });

  it("Claude batch failures (all null) still allow rule-engine partial success", async () => {
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

    // BND-262: batch Claude returns some nulls (failed) and some successes
    mockEnrichWinesWithClaudeBatch.mockResolvedValueOnce([
      null, // w-2 failed
      {
        drinkWindowStart: 2021,
        drinkWindowEnd: 2030,
        peakYear: 2026,
        ratingSource: "claude_inference",
        reviewExcerpt: "Approachable now, peaks 2026.",
        servingTempMin: null,
        servingTempMax: null,
        servingTempLabel: null,
      },
    ]);

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 2, error: null },
    });
    mockRequireCapability.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleEnrichedCount).toBe(1);
    expect(body.claudeAttemptedCount).toBe(2);
    expect(body.claudeEnrichedCount).toBe(1); // only w-3 succeeded

    // Verify single batch call
    expect(mockEnrichWinesWithClaudeBatch).toHaveBeenCalledTimes(1);

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    const args = enrichCall!.args as { p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_enrichments).toHaveLength(2);
    // w-1 (rule) + w-3 (claude) = 2 enriched
    const ids = args.p_enrichments.map((r) => r.id);
    expect(ids).toContain("w-1");
    expect(ids).toContain("w-3");
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
    mockRequireCapability.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST(request());
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
    mockRequireCapability.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(rpcCalls.filter((c) => c.fn === "enrich_wines_batch")).toHaveLength(1);
    expect(rpcCalls.find((c) => c.fn === "match_lwin_batch")).toBeUndefined();
  });
});
