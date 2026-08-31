import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException }));

const { GET } = await import("./route");

function makeSupabase(options?: {
  wines?: Array<Record<string, unknown>>;
  // SCAN-06: the fuzzy fallback issues a SECOND wines query for the RPC's
  // candidate ids, so a test that exercises it has to be able to answer the
  // two calls differently.
  winesByCall?: Array<Array<Record<string, unknown>>>;
  openBottles?: Array<Record<string, unknown>>;
  inventory?: Array<Record<string, unknown>>;
  fuzzy?: Array<{ wine_id: string; score: number }>;
  fuzzyError?: { message: string } | null;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const wines = options?.wines ?? [{ id: "wine-1" }];
  const inventory = options?.inventory ?? [];
  let winesCall = 0;
  function makeChain(table: string) {
    const rows =
      table === "inventory_items"
        ? inventory
        : (options?.winesByCall?.[winesCall++] ?? wines);
    const chain = {
      select: (...args: unknown[]) => record(`${table}.select`, args),
      eq: (...args: unknown[]) => record(`${table}.eq`, args),
      in: (...args: unknown[]) => record(`${table}.in`, args),
      order: (...args: unknown[]) => record(`${table}.order`, args),
      limit: (...args: unknown[]) => record(`${table}.limit`, args),
      or: (...args: unknown[]) => record(`${table}.or`, args),
      ilike: (...args: unknown[]) => record(`${table}.ilike`, args),
      gte: (...args: unknown[]) => record(`${table}.gte`, args),
      lte: (...args: unknown[]) => record(`${table}.lte`, args),
      gt: (...args: unknown[]) => record(`${table}.gt`, args),
      then: (
        resolve: (value: { data: unknown[]; error: null }) => unknown,
      ) => resolve({ data: rows, error: null }),
    };
    function record(method: string, args: unknown[]) {
      calls.push({ method, args });
      return chain;
    }
    return chain;
  }
  return {
    supabase: {
      from: vi.fn((table: string) => makeChain(table)),
      rpc: vi.fn(async (name: string) =>
        name === "search_wines_fuzzy"
          ? { data: options?.fuzzy ?? [], error: options?.fuzzyError ?? null }
          : { data: options?.openBottles ?? [], error: null },
      ),
    },
    calls,
  };
}

describe("GET /api/wines/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("EV-4.3: applies all taxonomy params while retaining the response projection", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
    });
    const request = new NextRequest(
      "http://localhost/api/wines/search?" +
        "q=clos&producer=Jamet&region=Rhone&country=France&varietal=Syrah&" +
        "vintage_min=2016&vintage_max=2020&format=750",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(calls).toContainEqual({
      method: "wines.select",
      // colour + hero_image_url were added so a search result can render the
      // wine's picture, or the tinted stand-in when it has none.
      args: ["id, name, producer, vintage, varietal, region, colour, hero_image_url"],
    });
    expect(calls).toContainEqual({ method: "wines.ilike", args: ["producer", "Jamet"] });
    expect(calls).toContainEqual({ method: "wines.ilike", args: ["region", "Rhone"] });
    expect(calls).toContainEqual({ method: "wines.ilike", args: ["country", "France"] });
    expect(calls).toContainEqual({ method: "wines.ilike", args: ["varietal", "Syrah"] });
    expect(calls).toContainEqual({ method: "wines.gte", args: ["vintage", 2016] });
    expect(calls).toContainEqual({ method: "wines.lte", args: ["vintage", 2020] });
    expect(calls).toContainEqual({ method: "wines.eq", args: ["size_ml", 750] });
  });

  it("returns the membership response without querying", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search"),
    );
    expect(response.status).toBe(401);
  });

  it("quotes free-text search so PostgREST control characters stay data", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
    });
    const response = await GET(
      new NextRequest(
        "http://localhost/api/wines/search?q=clos%2Cproducer.eq.hacked%25",
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({
      method: "wines.or",
      args: [
        'name.ilike."%clos,producer.eq.hacked\\%%",producer.ilike."%clos,producer.eq.hacked\\%%"',
      ],
    });
  });

  it("rejects invalid facet numbers before querying wines", async () => {
    const { supabase } = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
    });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?vintage_min=recent"),
    );
    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("escapes LIKE wildcards so text facets remain exact matches", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
    });
    const response = await GET(
      new NextRequest(
        "http://localhost/api/wines/search?producer=100%25_Wines",
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({
      method: "wines.ilike",
      args: ["producer", "100\\%\\_Wines"],
    });
  });

  it("filter=out narrows to 86'd wines at the database", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?filter=out"),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({ method: "wines.eq", args: ["is_eightysixed", true] });
  });

  it("filter=drink-now applies the shared closing-window predicate", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?filter=drink-now"),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({ method: "wines.eq", args: ["is_eightysixed", false] });
    const year = new Date().getFullYear();
    expect(calls).toContainEqual({
      method: "wines.lte",
      args: ["drink_window_end", year + 2],
    });
  });

  it("filter=hold keeps only future-window wines", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?filter=hold"),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({
      method: "wines.gt",
      args: ["drink_window_start", new Date().getFullYear()],
    });
  });

  it("filter=open keeps only wines with an open bottle remaining", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: "wine-open" }, { id: "wine-sealed" }],
      openBottles: [
        { wine_id: "wine-open", open_remaining_ml: 400, size_ml: 750 },
        { wine_id: "wine-sealed", open_remaining_ml: 0, size_ml: 750 },
      ],
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?filter=open"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "wine-open" }]);
    expect(supabase.rpc).toHaveBeenCalledWith("list_open_bottle_items", {
      p_restaurant_id: "r1",
    });
  });

  it("filter=low mirrors the cellar total-ml predicate", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: "wine-low" }, { id: "wine-stocked" }, { id: "wine-no-list" }],
      openBottles: [
        { wine_id: "wine-low", open_remaining_ml: 100, size_ml: 750 },
        { wine_id: "wine-stocked", open_remaining_ml: 0, size_ml: 750 },
      ],
      inventory: [
        { wine_id: "wine-low", quantity: 1 },
        { wine_id: "wine-stocked", quantity: 6 },
        { wine_id: "wine-no-list", quantity: 0 },
      ],
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?filter=low"),
    );
    expect(response.status).toBe(200);
    // wine-low: 100 + 1*750 = 850 < 1500 → low. wine-stocked: 4500 → not low.
    // wine-no-list has no list item (no size_ml) → excluded, matching /cellar.
    expect(await response.json()).toEqual([{ id: "wine-low" }]);
  });

  it("rejects an unknown filter value", async () => {
    const { supabase } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });
    const response = await GET(
      new NextRequest("http://localhost/api/wines/search?filter=fancy"),
    );
    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  // SCAN-06 — the fuzzy fallback's wiring. What the matching itself actually
  // returns is not mockable and is proved against a real Postgres in
  // ./fuzzy-search-live.test.ts; these assert the route's half of the
  // contract: when it asks, what it asks with, and how it merges the answer.
  describe("SCAN-06 fuzzy fallback", () => {
    it("falls back to search_wines_fuzzy when the exact pass finds nothing", async () => {
      const { supabase } = makeSupabase({
        winesByCall: [[], [{ id: "w-b" }, { id: "w-a" }]],
        fuzzy: [
          { wine_id: "w-a", score: 1 },
          { wine_id: "w-b", score: 0.6 },
        ],
      });
      mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });

      const response = await GET(
        new NextRequest("http://localhost/api/wines/search?q=Fredric%20savart"),
      );

      expect(response.status).toBe(200);
      expect(supabase.rpc).toHaveBeenCalledWith("search_wines_fuzzy", {
        p_restaurant_id: "r1",
        p_query: "Fredric savart",
        // Load-bearing, and asserted as a literal on purpose: 'fredric' scores
        // 0.545455 against 'Frédéric', which clears 0.5 and fails pg_trgm's
        // 0.6 default. Letting this default anywhere reinstates the bug.
        p_threshold: 0.5,
        p_limit: 20,
      });
      // Ranked by the RPC's ordering, not by the `producer` order Postgres
      // returned the rows in.
      expect(await response.json()).toEqual([{ id: "w-a" }, { id: "w-b" }]);
    });

    it("keeps exact hits first and never re-fetches or duplicates them", async () => {
      const { supabase, calls } = makeSupabase({
        winesByCall: [[{ id: "w-exact" }], [{ id: "w-fuzzy" }]],
        fuzzy: [
          { wine_id: "w-exact", score: 1 },
          { wine_id: "w-fuzzy", score: 0.7 },
        ],
      });
      mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });

      const response = await GET(
        new NextRequest("http://localhost/api/wines/search?q=savart"),
      );

      expect(await response.json()).toEqual([{ id: "w-exact" }, { id: "w-fuzzy" }]);
      expect(calls).toContainEqual({ method: "wines.in", args: ["id", ["w-fuzzy"]] });
    });

    it("re-applies every facet predicate to the fuzzy candidates", async () => {
      // A fuzzy name match that ignored the caller's vintage or format filter
      // would be a different bug from the one SCAN-06 fixes.
      const { supabase, calls } = makeSupabase({
        winesByCall: [[], [{ id: "w-a" }]],
        fuzzy: [{ wine_id: "w-a", score: 1 }],
      });
      mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });

      const response = await GET(
        new NextRequest(
          "http://localhost/api/wines/search?q=savart&format=750&vintage_min=2016&region=Champagne",
        ),
      );

      expect(response.status).toBe(200);
      const count = (method: string, args: unknown[]) =>
        calls.filter(
          (call) =>
            call.method === method && JSON.stringify(call.args) === JSON.stringify(args),
        ).length;
      expect(count("wines.eq", ["size_ml", 750])).toBe(2);
      expect(count("wines.gte", ["vintage", 2016])).toBe(2);
      expect(count("wines.ilike", ["region", "Champagne"])).toBe(2);
      // The free-text ILIKE belongs to the exact pass only; re-applying it to
      // the fuzzy candidates would filter out every row the RPC just found.
      expect(calls.filter((call) => call.method === "wines.or")).toHaveLength(1);
    });

    it("does not reach for the RPC when there is no query", async () => {
      const { supabase } = makeSupabase({ winesByCall: [[]] });
      mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });

      const response = await GET(
        new NextRequest("http://localhost/api/wines/search"),
      );

      expect(response.status).toBe(200);
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        "search_wines_fuzzy",
        expect.anything(),
      );
    });

    it("does not reach for the RPC when the exact pass already answered", async () => {
      const { supabase } = makeSupabase({
        winesByCall: [
          [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
        ],
      });
      mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });

      const response = await GET(
        new NextRequest("http://localhost/api/wines/search?q=savart"),
      );

      expect(response.status).toBe(200);
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        "search_wines_fuzzy",
        expect.anything(),
      );
    });

    it("degrades to the exact result when the RPC is unavailable, and reports it", async () => {
      // AGENTS.md non-negotiable #7: migrations do not ride along with a
      // merge, so this route can be live before 0144 is applied. A missing
      // function must not 500 every search with fewer than five substring
      // hits — it must fall back to exactly the answer the route gave before
      // SCAN-06, and say so in Sentry.
      const { supabase } = makeSupabase({
        winesByCall: [[{ id: "w-exact" }]],
        fuzzyError: { message: "function does not exist" },
      });
      mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r1" });

      const response = await GET(
        new NextRequest("http://localhost/api/wines/search?q=savart"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ id: "w-exact" }]);
      expect(captureException).toHaveBeenCalledWith(
        { message: "function does not exist" },
        expect.objectContaining({
          tags: { surface: "wines-search", phase: "fuzzy-fallback" },
        }),
      );
    });
  });
});
