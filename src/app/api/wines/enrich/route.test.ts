import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * POST /api/wines/enrich tests (BND-031 + BND-039 + BND-261).
 *
 * The route ships enrichments to the `enrich_wines_batch` RPC in a single
 * round-trip. BND-039 added:
 *   • new metadata fields (peak_year, rating_source, review_excerpt)
 *   • Claude inference fallback for wines the rule engine misses
 *   • backwards compatibility — old callers / payload shape still work
 *
 * BND-261 added enrichment_metadata per wine in the payload:
 *   • source: "rule_engine" or "claude_inference"
 *   • fields_enriched: list of enriched field names
 *   • enriched_at: ISO timestamp
 *
 * Tests pin:
 *   1. Auth: 401 skips everything
 *   2. Fetch error: 500, no RPC call
 *   3. Happy path: rule-engine matches go in payload with enrichment_metadata
 *   4. Empty payload (no wines match any rule, Claude returns null): no RPC call
 *   5. RPC error → 500 with no LWIN fallback attempted
 *   6. Claude fallback: rule-engine misses are sent to Claude; results include
 *      enrichment_metadata with source="claude_inference"
 *   7. Claude failures don't abort the batch — partial success is fine
 *   8. Backwards compat: existing callers without producer/name still work
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockEnrichWine = vi.fn();
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: (...args: unknown[]) => mockEnrichWine(...args),
}));

const mockEnrichWineWithClaude = vi.fn();
vi.mock("@/lib/wine-intelligence/enrich-claude", () => ({
  enrichWineWithClaude: (...args: unknown[]) => mockEnrichWineWithClaude(...args),
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

  // ARCH-021 + BND-039: enrich fetch is now
  //   .select(producer, name, ...).eq().or(...).limit(...)
  // and the LWIN fetch is
  //   .select(id).eq().is(...).limit(...)
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
    // Default Claude mock: returns null (no inference, falls through).
    // Tests that exercise the Claude path override this.
    mockEnrichWineWithClaude.mockResolvedValue(null);
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
    expect(mockEnrichWineWithClaude).not.toHaveBeenCalled();
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
    expect(body.claudeAttemptedCount).toBe(1);
    expect(body.claudeEnrichedCount).toBe(0);

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    expect(enrichCall).toBeDefined();
    const args = enrichCall!.args as { p_restaurant_id: string; p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_restaurant_id).toBe("r-1");
    expect(args.p_enrichments).toHaveLength(2);
    expect(args.p_enrichments[0].id).toBe("w-1");
    // BND-039: new metadata fields are included in the payload
    expect(args.p_enrichments[0].peak_year).toBe(2028);
    expect(args.p_enrichments[0].rating_source).toBe("rule_engine");
    expect(args.p_enrichments[0].review_excerpt).toBeNull();
    // BND-261: enrichment_metadata is included
    const meta0 = args.p_enrichments[0].enrichment_metadata as Record<string, unknown>;
    expect(meta0).toBeDefined();
    expect(meta0.source).toBe("rule_engine");
    expect(meta0.fields_enriched).toEqual(
      expect.arrayContaining(["drink_window", "serving_temp", "peak_year", "rating_source"]),
    );
    expect(meta0.enriched_at).toEqual(expect.any(String));
    expect(args.p_enrichments[1].id).toBe("w-3");
    const meta1 = args.p_enrichments[1].enrichment_metadata as Record<string, unknown>;
    expect(meta1.source).toBe("rule_engine");
    expect(meta1.fields_enriched).toEqual(
      expect.arrayContaining(["drink_window", "serving_temp", "peak_year", "rating_source"]),
    );
  });

  it("Claude fallback enrichment_metadata has source=claude_inference (BND-261)", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "Krug", name: "Grande Cuvée", varietal: "Champagne Blend", region: "Champagne", country: "FR", vintage: 2008 },
    ];
    mockEnrichWine.mockReturnValueOnce(RULE_MISS);
    mockEnrichWineWithClaude.mockResolvedValueOnce({
      drinkWindowStart: 2018,
      drinkWindowEnd: 2032,
      peakYear: 2025,
      ratingSource: "claude_inference",
      reviewExcerpt: "Krug's flagship blends 120+ wines from 12+ vintages — drink with patience.",
      servingTempMin: null,
      servingTempMax: null,
      servingTempLabel: null,
    });

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 1, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleEnrichedCount).toBe(0);
    expect(body.claudeAttemptedCount).toBe(1);
    expect(body.claudeEnrichedCount).toBe(1);

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    const args = enrichCall!.args as { p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_enrichments).toHaveLength(1);
    expect(args.p_enrichments[0].id).toBe("w-1");
    expect(args.p_enrichments[0].rating_source).toBe("claude_inference");
    expect(args.p_enrichments[0].review_excerpt).toBe(
      "Krug's flagship blends 120+ wines from 12+ vintages — drink with patience.",
    );
    expect(args.p_enrichments[0].drink_window_start).toBe(2018);
    expect(args.p_enrichments[0].drink_window_end).toBe(2032);
    // BND-261: Claude enrichment_metadata
    const meta = args.p_enrichments[0].enrichment_metadata as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.source).toBe("claude_inference");
    expect(meta.fields_enriched).toEqual(
      expect.arrayContaining(["drink_window", "rating_source", "review_excerpt"]),
    );
    expect(meta.enriched_at).toEqual(expect.any(String));
  });

  it("Claude failures don't abort the batch — partial success preferred", async () => {
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

    // w-2: Claude returns null (rate-limited or parse error).
    // w-3: Claude succeeds.
    mockEnrichWineWithClaude
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        drinkWindowStart: 2021,
        drinkWindowEnd: 2030,
        peakYear: 2026,
        ratingSource: "claude_inference",
        reviewExcerpt: "Approachable now, peaks 2026.",
        servingTempMin: null,
        servingTempMax: null,
        servingTempLabel: null,
      });

    const { supabase, rpcCalls } = buildSupabase({
      winesResult: { data: wines, error: null },
      rpcEnrichResult: { data: 2, error: null },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1", role: "owner" });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleEnrichedCount).toBe(1);
    expect(body.claudeAttemptedCount).toBe(2);
    expect(body.claudeEnrichedCount).toBe(1); // only w-3 succeeded

    const enrichCall = rpcCalls.find((c) => c.fn === "enrich_wines_batch");
    const args = enrichCall!.args as { p_enrichments: Array<Record<string, unknown>> };
    expect(args.p_enrichments).toHaveLength(2);
    // Both enrichment payloads should have enrichment_metadata
    for (const row of args.p_enrichments) {
      expect(row.enrichment_metadata).toBeDefined();
    }
  });

  it("skips the RPC entirely when no wine matches any rule and Claude returns null", async () => {
    const wines: Wine[] = [
      { id: "w-1", producer: "X", name: "Mystery", varietal: "Obscure", region: "Nowhere", country: null, vintage: null },
    ];
    mockEnrichWine.mockReturnValue(RULE_MISS);
    // Default Claude mock returns null.

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
