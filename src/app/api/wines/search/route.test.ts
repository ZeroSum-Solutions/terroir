import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

function makeSupabase(options?: {
  wines?: Array<Record<string, unknown>>;
  openBottles?: Array<Record<string, unknown>>;
  inventory?: Array<Record<string, unknown>>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const wines = options?.wines ?? [{ id: "wine-1" }];
  const inventory = options?.inventory ?? [];
  function makeChain(table: string) {
    const rows = table === "inventory_items" ? inventory : wines;
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
      rpc: vi.fn(async () => ({ data: options?.openBottles ?? [], error: null })),
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
      args: ["id, name, producer, vintage, varietal, region"],
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
});
