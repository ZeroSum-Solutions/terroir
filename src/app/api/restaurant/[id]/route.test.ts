import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireOwner = vi.fn();
const mockRequireAuth = vi.fn();
const mockSetActiveRestaurant = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireOwner: (...args: unknown[]) => mockRequireOwner(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));
vi.mock("@/lib/api/active-restaurant", () => ({
  setActiveRestaurant: (...args: unknown[]) => mockSetActiveRestaurant(...args),
}));

const { PATCH, GET, PUT, DELETE } = await import("./route");

type ClaimRow = {
  outcome:
    | "claimed"
    | "replay"
    | "in_progress"
    | "mismatch"
    | "expired"
    | "outcome_unknown";
  response_status: number | null;
  response_body: unknown;
  response_headers: Record<string, string> | null;
};

function makeSupabase(
  updateError: unknown = null,
  claimRow: ClaimRow = {
    outcome: "claimed",
    response_status: null,
    response_body: null,
    response_headers: null,
  },
) {
  const updates: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async (operation: string) => {
    if (operation === "claim_api_idempotency") {
      return { data: [claimRow], error: null };
    }
    if (
      operation === "complete_api_idempotency" ||
      operation === "release_api_idempotency" ||
      operation === "fail_api_idempotency"
    ) {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${operation}`);
  });
  return {
    _updates: updates,
    rpc,
    from: (_t: string) => ({
      update: (row: Record<string, unknown>) => {
        updates.push(row);
        return {
          eq: () => ({
            then: (resolve: (v: { error: unknown }) => void) =>
              resolve({ error: updateError }),
          }),
        };
      },
    }),
  };
}

/**
 * Supabase mock for GET — supports chained .select().eq().eq().maybeSingle().
 */
function makeSupabaseForGet(
  membership: Record<string, unknown> | null,
  error: unknown = null,
) {
  return {
    from: (_t: string) => ({
      select: (_cols: string) => ({
        eq: (_k: string, _v: string) => ({
          eq: (_k2: string, _v2: string) => ({
            maybeSingle: () => Promise.resolve({ data: membership, error }),
          }),
        }),
      }),
    }),
  };
}

function makeSupabaseForDelete(deleteError: unknown = null) {
  const filters: Array<[string, string]> = [];
  const remove = vi.fn(() => ({
    eq: (column: string, value: string) => {
      filters.push([column, value]);
      return Promise.resolve({ error: deleteError });
    },
  }));
  return {
    filters,
    remove,
    supabase: { from: vi.fn(() => ({ delete: remove })) },
  };
}

function makeReq(body: unknown, key?: string): NextRequest {
  return new Request(`http://localhost/api/restaurant/${R}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

const R = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ id: R });

describe("GET /api/restaurant/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns restaurant metadata when user is a member", async () => {
    const sup = makeSupabaseForGet({
      role: "owner",
      restaurants: { name: "Test Bistro" },
    });
    mockRequireAuth.mockResolvedValue({
      supabase: sup,
      user: { id: "u-1", email: "u1@test.com" },
    });
    const res = await GET({} as NextRequest, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: R,
      name: "Test Bistro",
      role: "owner",
    });
  });

  it("403s when user is authenticated but not a member of the requested restaurant", async () => {
    const sup = makeSupabaseForGet(null);
    mockRequireAuth.mockResolvedValue({
      supabase: sup,
      user: { id: "u-1", email: "u1@test.com" },
    });
    const res = await GET({} as NextRequest, { params });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Not a member of this restaurant.");
  });

  it("401s when user is not authenticated", async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await GET({} as NextRequest, { params });
    expect(res.status).toBe(401);
  });

  it("redacts membership provider failures instead of returning 403", async () => {
    const sup = makeSupabaseForGet(null, {
      code: "XX000",
      message: "private database detail",
    });
    mockRequireAuth.mockResolvedValue({
      supabase: sup,
      user: { id: "u-1", email: "u1@test.com" },
    });

    const res = await GET({} as NextRequest, { params });

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("private");
  });
});

describe("PUT /api/restaurant/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets the active restaurant for a verified member", async () => {
    const supabase = { from: vi.fn() };
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });
    mockSetActiveRestaurant.mockResolvedValue({ ok: true });

    const res = await PUT({} as NextRequest, { params });

    expect(res.status).toBe(200);
    expect(mockSetActiveRestaurant).toHaveBeenCalledWith(supabase, "u-1", R);
  });

  it("returns a fixed 403 for a non-member", async () => {
    mockRequireAuth.mockResolvedValue({
      supabase: {},
      user: { id: "u-1" },
    });
    mockSetActiveRestaurant.mockResolvedValue({
      ok: false,
      reason: "not_member",
    });

    const res = await PUT({} as NextRequest, { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Not a member of this restaurant.",
      },
    });
  });

  it("redacts active-membership provider failures", async () => {
    mockRequireAuth.mockResolvedValue({
      supabase: {},
      user: { id: "u-1" },
    });
    mockSetActiveRestaurant.mockResolvedValue({
      ok: false,
      reason: "provider_error",
      cause: { message: "private provider detail" },
    });

    const res = await PUT({} as NextRequest, { params });

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("private");
  });
});

describe("PATCH /api/restaurant/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts name update (pre-existing behavior)", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(makeReq({ name: "New name" }), { params });
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toMatchObject({ name: "New name" });
  });

  it("preserves exact no-key response compatibility without idempotency RPCs", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await PATCH(makeReq({ name: "New name" }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Idempotency-Replayed")).toBeNull();
    expect(sup._updates).toEqual([{ name: "New name" }]);
    expect(sup.rpc).not.toHaveBeenCalled();
  });

  // BND-037b: the three new cases
  it("accepts auto_eightysix_from_inventory toggle", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ auto_eightysix_from_inventory: true }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toMatchObject({
      auto_eightysix_from_inventory: true,
    });
  });

  it("accepts eightysix_ml_threshold update", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ eightysix_ml_threshold: 250 }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toMatchObject({ eightysix_ml_threshold: 250 });
  });

  it("accepts both auto-86 fields in one call", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({
        auto_eightysix_from_inventory: true,
        eightysix_ml_threshold: 100,
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(sup._updates[0]).toEqual({
      auto_eightysix_from_inventory: true,
      eightysix_ml_threshold: 100,
    });
  });

  it("rejects a malformed key before mutation or claim", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await PATCH(makeReq({ name: "New name" }, "bad key!"), {
      params,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(sup._updates).toEqual([]);
    expect(sup.rpc).not.toHaveBeenCalled();
  });

  it("claims, hashes validated params and body, updates once, and completes", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await PATCH(
      makeReq(
        {
          eightysix_strategy: "mark",
          auto_eightysix_from_inventory: true,
        },
        KEY,
      ),
      { params },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await res.json()).toEqual({ ok: true });
    expect(sup._updates).toEqual([
      {
        auto_eightysix_from_inventory: true,
        eightysix_strategy: "mark",
      },
    ]);
    expect(sup.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      {
        p_restaurant_id: R,
        p_operation_id: "api:PATCH:/api/restaurant/{param}",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          id: R,
          auto_eightysix_from_inventory: true,
          eightysix_strategy: "mark",
        }),
      },
    );
    expect(sup.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: R,
        p_operation_id: "api:PATCH:/api/restaurant/{param}",
        p_idempotency_key: KEY,
        p_response_status: 200,
        p_response_body: { ok: true },
      }),
    );
  });

  it("replays a completed response without updating the restaurant", async () => {
    const sup = makeSupabase(null, {
      outcome: "replay",
      response_status: 200,
      response_body: { ok: true },
      response_headers: {},
    });
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await PATCH(makeReq({ name: "New name" }, KEY), {
      params,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await res.json()).toEqual({ ok: true });
    expect(sup._updates).toEqual([]);
    expect(sup.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects negative threshold", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ eightysix_ml_threshold: -10 }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields (strict)", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ foo: "bar" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("403s when targeting a different restaurant", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: "22222222-2222-4222-8222-222222222222",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      makeReq({ auto_eightysix_from_inventory: true }, KEY),
      { params },
    );
    expect(res.status).toBe(403);
    expect(sup._updates).toEqual([]);
    expect(sup.rpc).not.toHaveBeenCalled();
  });

  it("403s when caller is not owner (forwarded from requireOwner)", async () => {
    mockRequireOwner.mockResolvedValue(
      NextResponse.json({ error: "Owner access required." }, { status: 403 }),
    );
    const res = await PATCH(
      makeReq({ auto_eightysix_from_inventory: true }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it.each([
    ["invalid params", Promise.resolve({ id: "not-a-uuid" }), { name: "Valid" }],
    ["invalid body", params, { name: "" }],
    ["empty body", params, {}],
  ] as const)(
    "rejects %s before an idempotency claim or mutation",
    async (_label, candidateParams, body) => {
      const sup = makeSupabase();
      mockRequireOwner.mockResolvedValue({
        supabase: sup,
        restaurantId: R,
        user: { id: "u-1" },
        role: "owner",
      });

      const res = await PATCH(makeReq(body, KEY), {
        params: candidateParams,
      });

      expect(res.status).toBe(400);
      expect(sup._updates).toEqual([]);
      expect(sup.rpc).not.toHaveBeenCalled();
    },
  );

  it("redacts update provider failures", async () => {
    const sup = makeSupabase({ message: "private update detail" });
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await PATCH(makeReq({ name: "New name" }), { params });

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("private");
  });
});

describe("DELETE /api/restaurant/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes only the active owner restaurant", async () => {
    const db = makeSupabaseForDelete();
    mockRequireOwner.mockResolvedValue({
      supabase: db.supabase,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await DELETE({} as NextRequest, { params });

    expect(res.status).toBe(200);
    expect(db.filters).toEqual([["id", R]]);
  });

  it("rejects a different active restaurant before deletion", async () => {
    const db = makeSupabaseForDelete();
    mockRequireOwner.mockResolvedValue({
      supabase: db.supabase,
      restaurantId: "22222222-2222-4222-8222-222222222222",
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await DELETE({} as NextRequest, { params });

    expect(res.status).toBe(403);
    expect(db.remove).not.toHaveBeenCalled();
  });

  it("redacts delete provider failures", async () => {
    const db = makeSupabaseForDelete({ message: "private delete detail" });
    mockRequireOwner.mockResolvedValue({
      supabase: db.supabase,
      restaurantId: R,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await DELETE({} as NextRequest, { params });

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("private");
  });
});
