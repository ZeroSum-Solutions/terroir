import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

function makeSupabase() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = {
    select: (...args: unknown[]) => record("select", args),
    eq: (...args: unknown[]) => record("eq", args),
    order: (...args: unknown[]) => record("order", args),
    limit: (...args: unknown[]) => record("limit", args),
    or: (...args: unknown[]) => record("or", args),
    ilike: (...args: unknown[]) => record("ilike", args),
    gte: (...args: unknown[]) => record("gte", args),
    lte: (...args: unknown[]) => record("lte", args),
    then: (
      resolve: (value: { data: unknown[]; error: null }) => unknown,
    ) => resolve({ data: [{ id: "wine-1" }], error: null }),
  };
  function record(method: string, args: unknown[]) {
    calls.push({ method, args });
    return chain;
  }
  return {
    supabase: { from: vi.fn(() => chain) },
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
      method: "select",
      args: ["id, name, producer, vintage, varietal, region"],
    });
    expect(calls).toContainEqual({ method: "ilike", args: ["producer", "Jamet"] });
    expect(calls).toContainEqual({ method: "ilike", args: ["region", "Rhone"] });
    expect(calls).toContainEqual({ method: "ilike", args: ["country", "France"] });
    expect(calls).toContainEqual({ method: "ilike", args: ["varietal", "Syrah"] });
    expect(calls).toContainEqual({ method: "gte", args: ["vintage", 2016] });
    expect(calls).toContainEqual({ method: "lte", args: ["vintage", 2020] });
    expect(calls).toContainEqual({ method: "eq", args: ["size_ml", 750] });
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
      method: "or",
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
      method: "ilike",
      args: ["producer", "100\\%\\_Wines"],
    });
  });
});
