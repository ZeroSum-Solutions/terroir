import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { PATCH } = await import("./route");

function makeSupabase() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    _updates: updates,
    from: (_t: string) => ({
      update: (row: Record<string, unknown>) => {
        updates.push(row);
        return {
          eq: () => ({
            then: (resolve: (v: { error: null }) => void) =>
              resolve({ error: null }),
          }),
        };
      },
    }),
  };
}

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as NextRequest;
}

const params = Promise.resolve({ id: "a1b2c3d4-e5f6-4789-8abc-def012345678" });

describe("PATCH /api/wine-list-items/[id] — pour-size extension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts glass_pour_ml", async () => {
    const sup = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: 148 }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toMatchObject({ glass_pour_ml: 148 });
  });

  it("accepts pour_size_mode", async () => {
    const sup = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ pour_size_mode: "picker" }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toMatchObject({ pour_size_mode: "picker" });
  });

  it("accepts null glass_pour_ml (disabling tracking)", async () => {
    const sup = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: null }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toHaveProperty("glass_pour_ml", null);
  });

  it("rejects negative glass_pour_ml", async () => {
    const sup = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: -10 }), { params });
    expect(res.status).toBe(400);
  });

  it("rejects invalid pour_size_mode", async () => {
    const sup = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ pour_size_mode: "bogus" }), { params });
    expect(res.status).toBe(400);
  });

  it("still accepts the pre-existing fields (glass_price, is_available)", async () => {
    const sup = makeSupabase();
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ glass_price: 14.5, is_available: true }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toMatchObject({
      glass_price: 14.5,
      is_available: true,
    });
  });
});
