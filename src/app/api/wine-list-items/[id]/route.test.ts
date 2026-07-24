import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
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
type EqTarget = {
  column: string;
  value: string;
};

type OwnershipRead = {
  table: string;
  columns: string;
  eq: EqTarget;
};

type UpdateMutation = {
  table: string;
  payload: Record<string, unknown>;
  eq: EqTarget;
};

type DeleteMutation = {
  table: string;
  eq: EqTarget;
};

function makeSupabase(
  options: { ownedByRestaurant?: string } = { ownedByRestaurant: "r-A" },
) {
  const ownershipReads: OwnershipRead[] = [];
  const updates: UpdateMutation[] = [];
  const deletes: DeleteMutation[] = [];
  return {
    _ownershipReads: ownershipReads,
    _updates: updates,
    _deletes: deletes,
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          maybeSingle: async () => {
            ownershipReads.push({
              table,
              columns,
              eq: { column, value },
            });
            if (!options.ownedByRestaurant) {
              return { data: null, error: null };
            }
            return {
              data: {
                id: value,
                section_id: "section-1",
                wine_list_sections: {
                  wine_lists: {
                    restaurant_id: options.ownedByRestaurant,
                  },
                },
              },
              error: null,
            };
          },
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        const chain = {
          eq: (column: string, value: string) => {
            if (updates.length === 0) {
              updates.push({
                table,
                payload,
                eq: { column, value },
              });
            }
            return chain;
          },
          select: () => chain,
          maybeSingle: async () => ({ data: { id: ITEM_ID }, error: null }),
        };
        return chain;
      },
      delete: () => {
        const chain = {
          eq: (column: string, value: string) => {
            if (deletes.length === 0) {
              deletes.push({
                table,
                eq: { column, value },
              });
            }
            return chain;
          },
          select: () => chain,
          maybeSingle: async () => ({ data: { id: ITEM_ID }, error: null }),
        };
        return chain;
      },
    }),
  };
}

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/wine-list-items/${ITEM_ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const ITEM_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const OWNERSHIP_COLUMNS =
  "id, section_id, wine_list_sections!inner(wine_lists!inner(restaurant_id))";
const ITEM_NOT_FOUND_BODY = {
  error: { code: "not_found", message: "Item not found." },
};
const params = Promise.resolve({ id: ITEM_ID });

function authResponse(
  status: 401 | 403,
  supabase: ReturnType<typeof makeSupabase>,
) {
  const deniedIdentity =
    status === 403
      ? { user: { id: "u-staff" }, role: "staff" as const }
      : { user: undefined, role: undefined };

  return Object.assign(
    NextResponse.json(
      { error: { code: status === 401 ? "unauthorized" : "forbidden" } },
      { status },
    ),
    {
      supabase,
      restaurantId: "r-A",
      ...deniedIdentity,
    },
  );
}

function mockRoleAuth(
  supabase: ReturnType<typeof makeSupabase>,
  role: "owner" | "manager",
) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "r-A",
    user: { id: `u-${role}` },
    role,
  });
}

function expectNoWrite(supabase: ReturnType<typeof makeSupabase>) {
  expect(supabase._updates).toEqual([]);
  expect(supabase._deletes).toEqual([]);
}

function expectedOwnershipRead(): OwnershipRead {
  return {
    table: "wine_list_items",
    columns: OWNERSHIP_COLUMNS,
    eq: { column: "id", value: ITEM_ID },
  };
}

async function expectOpaqueItemNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual(ITEM_NOT_FOUND_BODY);
}

const routeCases = [
  {
    method: "PATCH",
    invoke: (body: unknown = { glass_price: 14.5 }) =>
      PATCH(makeReq(body), { params }),
  },
  {
    method: "DELETE",
    invoke: (_body?: unknown) => DELETE({} as NextRequest, { params }),
  },
] as const;

describe.each(routeCases)(
  "$method /api/wine-list-items/[id] — authorization",
  ({ method, invoke }) => {
    beforeEach(() => vi.clearAllMocks());

    it.each([
      { actor: "unauthenticated callers", status: 401 as const },
      { actor: "staff", status: 403 as const },
    ])("rejects $actor before any read or write", async ({ status }) => {
      const supabase = makeSupabase({ ownedByRestaurant: "r-A" });
      mockRequireRole.mockResolvedValue(authResponse(status, supabase));

      const response = await invoke();

      expect(response.status).toBe(status);
      expect(mockRequireRole).toHaveBeenCalledTimes(1);
      expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
      expect(supabase._ownershipReads).toEqual([]);
      expectNoWrite(supabase);
    });

    it.each(["owner", "manager"] as const)(
      "allows same-tenant %s",
      async (role) => {
        const supabase = makeSupabase({ ownedByRestaurant: "r-A" });
        mockRoleAuth(supabase, role);

        const response = await invoke();

        expect(response.status).toBe(200);
        expect(mockRequireRole).toHaveBeenCalledTimes(1);
        expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
        expect(supabase._ownershipReads).toEqual([expectedOwnershipRead()]);
        if (method === "PATCH") {
          expect(supabase._updates).toEqual([
            {
              table: "wine_list_items",
              payload: { glass_price: 14.5 },
              eq: { column: "id", value: ITEM_ID },
            },
          ]);
          expect(supabase._deletes).toEqual([]);
        } else {
          expect(supabase._updates).toEqual([]);
          expect(supabase._deletes).toEqual([
            {
              table: "wine_list_items",
              eq: { column: "id", value: ITEM_ID },
            },
          ]);
        }
      },
    );

    it.each(["owner", "manager"] as const)(
      "returns an opaque 404 without writing for cross-tenant %s",
      async (role) => {
        const supabase = makeSupabase({ ownedByRestaurant: "r-B" });
        mockRoleAuth(supabase, role);

        const response = await invoke();

        await expectOpaqueItemNotFound(response);
        expect(supabase._ownershipReads).toEqual([expectedOwnershipRead()]);
        expectNoWrite(supabase);
      },
    );

    it("returns 404 without writing when the item does not exist", async () => {
      const supabase = makeSupabase({ ownedByRestaurant: undefined });
      mockRoleAuth(supabase, "owner");

      const response = await invoke();

      await expectOpaqueItemNotFound(response);
      expect(supabase._ownershipReads).toEqual([expectedOwnershipRead()]);
      expectNoWrite(supabase);
    });
  },
);

describe("PATCH /api/wine-list-items/[id] — validation ordering", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { label: "invalid body", body: { glass_pour_ml: -10 } },
    { label: "deprecated field", body: { is_available: false } },
    { label: "empty body", body: {} },
  ])("returns 400 without ownership lookup or write for $label", async ({ body }) => {
    const supabase = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRoleAuth(supabase, "owner");

    const response = await PATCH(makeReq(body), { params });

    expect(response.status).toBe(400);
    expect(mockRequireRole).toHaveBeenCalledTimes(1);
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
    expect(supabase._ownershipReads).toEqual([]);
    expectNoWrite(supabase);
  });
});

describe("PATCH /api/wine-list-items/[id] — pour-size extension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts glass_pour_ml", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: 148 }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]?.payload).toMatchObject({ glass_pour_ml: 148 });
  });

  it("accepts pour_size_mode", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ pour_size_mode: "picker" }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]?.payload).toMatchObject({
      pour_size_mode: "picker",
    });
  });

  it("accepts null glass_pour_ml (disabling tracking)", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ glass_pour_ml: null }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]?.payload).toHaveProperty("glass_pour_ml", null);
  });

  it("rejects negative glass_pour_ml", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireRole.mockResolvedValue({
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
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ pour_size_mode: "bogus" }), { params });
    expect(res.status).toBe(400);
  });

  it("still accepts the pre-existing fields (glass_price)", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ glass_price: 14.5 }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(sup._updates[0]?.payload).toMatchObject({ glass_price: 14.5 });
  });

  // ARCH-017 / DEBT-011: deprecated is_available is rejected.
  it("400s when the body writes deprecated is_available", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-A" });
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ is_available: false }), { params });
    expect(res.status).toBe(400);
    expect(sup._updates).toHaveLength(0);
  });

  // ARCH-014: ownership enforcement
  it("404s when the item belongs to another restaurant", async () => {
    const sup = makeSupabase({ ownedByRestaurant: "r-B" });
    mockRequireRole.mockResolvedValue({
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
    mockRequireRole.mockResolvedValue({
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
    mockRequireRole.mockResolvedValue({
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
    mockRequireRole.mockResolvedValue({
      supabase: sup,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await DELETE({} as NextRequest, { params });
    expect(res.status).toBe(404);
  });
});
