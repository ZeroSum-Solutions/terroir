import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __parseForTests,
  __resetWineSearcherForTests,
  fetchRetailPrices,
  formatRetailPriceBasis,
} from "./wine-searcher";

// Network-touching code (fetchRetailPrices) is intentionally NOT tested
// for business logic here — we'd be testing the fetch wrapper, not our logic.
// Schema validation + parsing is exhaustively unit-tested instead. End-to-end
// happens via manual smoke against real wines (per BND-040 plan §Verification).
// Security invariants for the fetch call (key-not-in-URL, key-in-header) ARE
// tested below.

describe("Wine-Searcher response parser", () => {
  it("prefers a true median when average and median fields are both present", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      median_price: 95,
      offers_count: 142,
    });
    expect(result?.retailMin).toBe(80);
    expect(result?.retailMax).toBe(110);
    expect(result?.retailMedian).toBe(95);
    expect(result?.retailMedianBasis).toBe("median");
    expect(result?.retailerCount).toBe(142);
  });

  it("labels an average fallback as avg-based", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      offers_count: 142,
    });

    expect(result?.retailMedian).toBe(92);
    expect(result?.retailMedianBasis).toBe("average");
    expect(result && formatRetailPriceBasis(result.retailMedianBasis)).toBe(
      "avg-based",
    );
  });

  it("parses a wine-wrapped response variant", () => {
    const result = __parseForTests({
      wine: {
        priceMin: 80,
        priceMax: 110,
        priceAvg: 92,
        merchant_count: 142,
      },
    });
    expect(result?.retailMin).toBe(80);
    expect(result?.retailMax).toBe(110);
  });

  it("accepts string numbers (some Wine-Searcher tiers return strings)", () => {
    const result = __parseForTests({
      min_price: "80.00",
      max_price: "110.00",
      average_price: "92.50",
      offers_count: "142",
    });
    expect(result?.retailMedian).toBe(92.5);
  });

  it("rejects non-object body", () => {
    expect(__parseForTests(null)).toBeNull();
    expect(__parseForTests("garbage")).toBeNull();
    expect(__parseForTests(42)).toBeNull();
  });

  it("rejects when min or max is missing", () => {
    expect(__parseForTests({ min_price: 80 })).toBeNull();
  });

  it("returns null when median and average are both absent", () => {
    expect(__parseForTests({ min_price: 80, max_price: 110 })).toBeNull();
  });

  it("rejects negative prices", () => {
    expect(
      __parseForTests({
        min_price: -5,
        max_price: 110,
        average_price: 92,
        offers_count: 142,
      }),
    ).toBeNull();
  });

  it("rejects when max < min", () => {
    expect(
      __parseForTests({
        min_price: 110,
        max_price: 80,
        average_price: 92,
        offers_count: 142,
      }),
    ).toBeNull();
  });

  it("rejects when the preferred true median is outside [min, max]", () => {
    expect(
      __parseForTests({
        min_price: 80,
        max_price: 110,
        average_price: 92,
        median_price: 200,
        offers_count: 142,
      }),
    ).toBeNull();
  });

  it("normalizes retailer count to non-negative integer", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      offers_count: -1,
    });
    // -1 is invalid; falls through to 0
    expect(result?.retailerCount).toBe(0);
  });

  it("handles missing retailer count gracefully", () => {
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
    });
    expect(result?.retailerCount).toBe(0);
  });

  it("attaches a refresh timestamp", () => {
    const before = Date.now();
    const result = __parseForTests({
      min_price: 80,
      max_price: 110,
      average_price: 92,
      offers_count: 142,
    });
    const after = Date.now();
    expect(result?.refreshedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result?.refreshedAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("fetchRetailPrices — security invariants", () => {
  const SENTINEL = "TEST-SENTINEL-DO-NOT-LEAK";

  beforeEach(() => {
    __resetWineSearcherForTests();
    vi.stubEnv("WINE_SEARCHER_API_KEY", SENTINEL);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          min_price: 80,
          max_price: 110,
          average_price: 92,
          offers_count: 10,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does NOT include the API key in the URL query string", async () => {
    await fetchRetailPrices({ lwinId: "1234567" });
    const [calledUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).not.toContain(SENTINEL);
  });

  it("sends the API key in the Authorization header", async () => {
    await fetchRetailPrices({ lwinId: "1234567" });
    const [, calledInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const authHeader = (calledInit?.headers as Record<string, string>)?.["Authorization"] ?? "";
    expect(authHeader).toContain(SENTINEL);
  });
});
