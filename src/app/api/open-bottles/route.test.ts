import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

type Row = {
  wine_list_item_id: string;
  glass_pour_ml: number | null;
  pour_size_mode: "fixed" | "picker";
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  size_ml: number;
  open_remaining_ml: number | null;
  opened_at: string | null;
  sealed_count: number;
};

function makeSupabase(rows: Row[], expectedRestaurantId?: string) {
  return {
    rpc: (_fn: string, args: { p_restaurant_id: string }) => ({
      then: (
        resolve: (v: { data: Row[]; error: null }) => void,
      ) => {
        if (expectedRestaurantId && args.p_restaurant_id !== expectedRestaurantId) {
          resolve({ data: [], error: null });
          return;
        }
        resolve({ data: rows, error: null });
      },
    }),
  };
}

function makeRequest(): NextRequest {
  return {
    nextUrl: new URL("http://localhost:3000/api/open-bottles"),
  } as NextRequest;
}

describe("GET /api/open-bottles", () => {
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

  it("returns items with open-bottle state on happy path", async () => {
    const rows: Row[] = [
      {
        wine_list_item_id: "wli-1",
        glass_pour_ml: 148,
        pour_size_mode: "fixed",
        wine_id: "w-1",
        name: "Volnay 1er Cru",
        producer: "Domaine Leflaive",
        vintage: 2019,
        size_ml: 750,
        open_remaining_ml: 602,
        opened_at: "2026-04-22T00:00:00Z",
        sealed_count: 4,
      },
      {
        wine_list_item_id: "wli-2",
        glass_pour_ml: 148,
        pour_size_mode: "picker",
        wine_id: "w-2",
        name: "Barolo",
        producer: "Giacosa",
        vintage: 2016,
        size_ml: 750,
        open_remaining_ml: null,
        opened_at: null,
        sealed_count: 2,
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
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      wine_id: "w-1",
      glass_pour_ml: 148,
      open_remaining_ml: 602,
    });
    expect(body.items[1].open_remaining_ml).toBeNull();
  });
});
