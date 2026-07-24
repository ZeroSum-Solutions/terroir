import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { POST } = await import("./route");

type BottleRow = {
  id: string;
  wine_id: string;
  remaining_ml: number;
  closed_at: string | null;
  restaurant_id: string;
};

function makeSupabase(opts: {
  bottle: BottleRow | null;
  fetchError?: unknown;
  recordPourError?: { code?: string; message?: string } | null;
}) {
  const rpc = vi.fn((fn: string, _args: unknown) => {
    if (fn === "record_pour") {
      return Promise.resolve({ data: null, error: opts.recordPourError ?? null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const bottleQuery = {
    eq: vi.fn(() => bottleQuery),
    single: () =>
      Promise.resolve({
        data: opts.bottle,
        error: opts.fetchError ?? null,
      }),
  };
  const from = vi.fn(() => ({
    select: () => bottleQuery,
  }));
  return { supabase: { rpc, from }, rpc, bottleQuery };
}

const BOTTLE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";

function makeContext(id = BOTTLE_ID) {
  return { params: Promise.resolve({ id }) };
}

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

describe("POST /api/open-bottles/[id]/close", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST({} as NextRequest, makeContext());

    expect(res.status).toBe(401);
  });

  it("closes an open bottle through record_pour and revalidates open cellar", async () => {
    const { supabase, rpc } = makeSupabase({
      bottle: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 125,
        closed_at: null,
        restaurant_id: "r-A",
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST({} as NextRequest, makeContext());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      closed: { id: BOTTLE_ID, wine_id: WINE_ID },
    });
    expect(rpc).toHaveBeenCalledWith("record_pour", {
      p_restaurant_id: "r-A",
      p_wine_id: WINE_ID,
      p_ml: 125,
      p_kind: "spill",
      p_note: "Bottle closed (discard remaining)",
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/cellar/open");
  });

  it("returns 404 when the bottle is missing", async () => {
    const { supabase } = makeSupabase({ bottle: null });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
  });

  it("returns 404 for the PostgREST no-row code", async () => {
    const { supabase } = makeSupabase({
      bottle: null,
      fetchError: { code: "PGRST116", message: "no rows" },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Bottle not found." },
    });
  });

  it("redacts a real bottle-fetch failure instead of reporting 404", async () => {
    const { supabase } = makeSupabase({
      bottle: null,
      fetchError: { code: "XX000", message: "super-secret database failure" },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST({} as NextRequest, makeContext());
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(text).not.toContain("super-secret");
  });

  it("returns the same opaque 404 when the bottle belongs to another restaurant", async () => {
    const { supabase, bottleQuery } = makeSupabase({
      bottle: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 125,
        closed_at: null,
        restaurant_id: "r-B",
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
    expect(bottleQuery.eq).toHaveBeenCalledWith("restaurant_id", "r-A");
  });

  it("returns 409 when the bottle is already closed", async () => {
    const { supabase } = makeSupabase({
      bottle: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 125,
        closed_at: "2026-07-03T00:00:00Z",
        restaurant_id: "r-A",
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST({} as NextRequest, makeContext());

    expect(res.status).toBe(409);
  });
});
