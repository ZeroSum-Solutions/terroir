import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

type WineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  is_eightysixed: boolean;
  eightysixed_at: string | null;
  eightysixed_by: string | null;
};

type MockState = {
  filters: Array<[string, string]>;
  range: { from: number; to: number } | null;
};

function makeSupabase(rows: WineRow[], expectedRestaurantId?: string) {
  const state: MockState = { filters: [], range: null };
  const chain = {
    _state: state,
    select: () => chain,
    eq: (col: string, val: string) => {
      state.filters.push([col, val]);
      return chain;
    },
    order: () => chain,
    range: (from: number, to: number) => {
      state.range = { from, to };
      return chain;
    },
    then: (
      resolve: (v: {
        data: WineRow[];
        error: null;
        count: number;
      }) => void,
    ) => {
      if (expectedRestaurantId) {
        const eq = state.filters.find(([c]) => c === "restaurant_id");
        if (!eq || eq[1] !== expectedRestaurantId) {
          resolve({ data: [], error: null, count: 0 });
          return;
        }
      }
      const sliced = state.range
        ? rows.slice(state.range.from, state.range.to + 1)
        : rows;
      resolve({ data: sliced, error: null, count: rows.length });
    },
  };
  return { from: (_table: string) => chain };
}

function makeRequest(search = ""): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:3000/api/wines/availability${search}`),
  } as NextRequest;
}

function makeRow(id: string, name: string, is_eightysixed = false): WineRow {
  return {
    id,
    name,
    producer: "X",
    vintage: 2020,
    varietal: "Pinot Noir",
    region: "Burgundy",
    is_eightysixed,
    eightysixed_at: null,
    eightysixed_by: null,
  };
}

describe("GET /api/wines/availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns wines with availability fields on happy path", async () => {
    const rows: WineRow[] = [
      { ...makeRow("w-1", "Volnay 1er Cru") },
      {
        ...makeRow("w-2", "Chambertin", true),
        eightysixed_at: "2026-04-21T18:45:00Z",
        eightysixed_by: "u-1",
      },
    ];
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase(rows, "r-A"),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wines).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.wines[0]).toMatchObject({
      id: "w-1",
      is_eightysixed: false,
      eightysixed_by: null,
    });
    expect(body.wines[1]).toMatchObject({
      id: "w-2",
      is_eightysixed: true,
      eightysixed_by: "u-1",
    });
    // No Link header when total <= limit.
    expect(res.headers.get("Link")).toBeNull();
    expect(res.headers.get("X-Total-Count")).toBe("2");
  });

  it("scopes to caller's restaurant — other-tenant rows filtered if route forgets .eq('restaurant_id', ...)", async () => {
    const ownRows: WineRow[] = [makeRow("w-own", "Ours")];
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase(ownRows, "r-OWN"),
      restaurantId: "r-OWN",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wines).toHaveLength(1);
    expect(body.wines[0].id).toBe("w-own");
  });

  it("paginates with ?limit and ?offset and emits RFC 5988 Link header", async () => {
    // 5 rows, limit=2, offset=0 → returns rows 0-1, next=offset=2.
    const rows: WineRow[] = [
      makeRow("w-1", "A"),
      makeRow("w-2", "B"),
      makeRow("w-3", "C"),
      makeRow("w-4", "D"),
      makeRow("w-5", "E"),
    ];
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase(rows, "r-A"),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await GET(makeRequest("?limit=2&offset=0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wines).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);

    const link = res.headers.get("Link");
    expect(link).not.toBeNull();
    expect(link).toContain('rel="first"');
    expect(link).toContain('rel="last"');
    expect(link).toContain('rel="next"');
    // offset=0 → no prev.
    expect(link).not.toContain('rel="prev"');
    // next points to offset=2
    expect(link).toMatch(/offset=2[^,]*rel="next"/);
    // last for total=5 with limit=2 → offset=4
    expect(link).toMatch(/offset=4[^,]*rel="last"/);
  });

  it("rejects out-of-range limit and offset values", async () => {
    const rows: WineRow[] = [makeRow("w-1", "A")];
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase(rows, "r-A"),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await GET(makeRequest("?limit=99999&offset=-10"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("emits first and previous links for an offset beyond a short result set", async () => {
    const rows: WineRow[] = [makeRow("w-1", "A")];
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase(rows, "r-A"),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await GET(makeRequest("?limit=1000&offset=1000"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Link")).toContain('rel="first"');
    expect(res.headers.get("Link")).toContain('rel="prev"');
  });
});
