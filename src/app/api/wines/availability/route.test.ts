import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

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

function makeSupabase(rows: WineRow[], expectedRestaurantId?: string) {
  return {
    from: (_table: string) => {
      const filters: Array<[string, string]> = [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          filters.push([col, val]);
          return chain;
        },
        order: () => chain,
        then: (resolve: (v: { data: WineRow[]; error: null }) => void) => {
          // Scope check: the RESTful route MUST filter by restaurant_id.
          // If the test sets an expectedRestaurantId and the route fails
          // to eq() on it, the mock returns [] and the test catches it.
          if (expectedRestaurantId) {
            const eq = filters.find(([c]) => c === "restaurant_id");
            if (!eq || eq[1] !== expectedRestaurantId) {
              resolve({ data: [], error: null });
              return;
            }
          }
          resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
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
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns wines with availability fields on happy path", async () => {
    const rows: WineRow[] = [
      {
        id: "w-1",
        name: "Volnay 1er Cru",
        producer: "Domaine Leflaive",
        vintage: 2019,
        varietal: "Pinot Noir",
        region: "Burgundy",
        is_eightysixed: false,
        eightysixed_at: null,
        eightysixed_by: null,
      },
      {
        id: "w-2",
        name: "Chambertin",
        producer: "Rousseau",
        vintage: 2015,
        varietal: "Pinot Noir",
        region: "Burgundy",
        is_eightysixed: true,
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

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wines).toHaveLength(2);
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
  });

  it("scopes to caller's restaurant — other-tenant rows filtered if route forgets .eq('restaurant_id', ...)", async () => {
    const ownRows: WineRow[] = [
      {
        id: "w-own",
        name: "Ours",
        producer: "X",
        vintage: 2020,
        varietal: "Chardonnay",
        region: "Burgundy",
        is_eightysixed: false,
        eightysixed_at: null,
        eightysixed_by: null,
      },
    ];
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase(ownRows, "r-OWN"),
      restaurantId: "r-OWN",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wines).toHaveLength(1);
    expect(body.wines[0].id).toBe("w-own");
  });
});
