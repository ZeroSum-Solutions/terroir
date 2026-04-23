import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { PATCH, DELETE } = await import("./route");

/**
 * Mock client that supports both:
 *   1. `isOwnWineListItem(supabase, id, restaurantId)` — hits
 *      from('wine_list_items').select(...).eq('id', id).single()
 *   2. The actual mutation — from('wine_list_items').update(...).eq('id', id)
 *
 * The first call after `.from('wine_list_items')` is ALWAYS
 * `.select(...)` (ownership check) in the current route flow; the
 * second uses `.update(...)`. This mock tracks which path is active
 * and returns appropriate data for each.
 */
function makeSupabase(
  options: { ownedByRestaurant?: string } = { ownedByRestaurant: "r-A" },
) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    _updates: updates,
    from: (_t: string) => ({
      // Ownership check: .select().eq().single()
      select: (_cols: string) => ({
        eq: () => ({
          single: () => ({
            then: (
              resolve: (v: {
                data: unknown | null;
                error: null | { message: string };
              }) => void,
            ) => {
              if (options.ownedByRestaurant) {
                resolve({
                  data: {
                    wine_list_sections: {
                      wine_lists: {
                        restaurant_id: options.ownedByRestaurant,
                      },
                    },
                  },
                  error: null,
                });
              } else {
                resolve({ data: null, error: { message: "not found" } });
              }
            },
          }),
        }),
      }),
      // Mutation: .update().eq() or .delete().eq()
      update: (row: Record<string, unknown>) => {
        updates.push(row);
        return {
          eq: () => ({
            then: (resolve: (v: { error: null }) => void) =>
              resolve({ error: null }),
          }),
        };
      },
      delete: () => ({
        eq: () => ({
          then: (resolve: (v: { error: null }) => void) =>
            resolve({ error: null }),
        }),
      }),
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
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
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
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
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
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
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
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
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
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
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
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
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

  // ARCH-014: ownership enforcement
  it("404s when the item belongs to another restaurant", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-B" });
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: 148 }), { params });
    expect(res.status).toBe(404);
    expect(sup._updates).toHaveLength(0);
  });

  it("404s when the item is not found", async () => {
    const sup = makeSupabase({ ownedByRestaurant: undefined });
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: 148 }), { params });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/wine-list-items/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200s when the item belongs to the caller's restaurant", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await DELETE({} as NextRequest, { params });
    expect(res.status).toBe(200);
  });

  it("404s when the item is cross-tenant", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-B" });
    mockRequireMembership.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await DELETE({} as NextRequest, { params });
    expect(res.status).toBe(404);
  });
});
