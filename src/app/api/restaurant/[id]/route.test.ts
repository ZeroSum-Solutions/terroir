import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireOwner = vi.fn();
const mockRequireAuth = vi.fn();
const mockVerifyActiveRestaurantMembership = vi.fn();
const mockResolveActiveMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireOwner: (...args: unknown[]) => mockRequireOwner(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));
vi.mock("@/lib/api/active-restaurant", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/api/active-restaurant")
    >();
  return {
    ...original,
    verifyActiveRestaurantMembership: (...args: unknown[]) =>
      mockVerifyActiveRestaurantMembership(...args),
  };
});
vi.mock("@/lib/api/resolve-active-membership", () => ({
  resolveActiveMembership: (...args: unknown[]) =>
    mockResolveActiveMembership(...args),
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

type DeleteResultRow = {
  outcome:
    | "deleted"
    | "replay"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress"
    | "no_membership"
    | "owner_required"
    | "forbidden";
  response_status: number;
  response_body: unknown;
  replayed: boolean;
  execution_started_at: string;
};

function makeSupabaseForDelete(
  row: DeleteResultRow = {
    outcome: "deleted",
    response_status: 200,
    response_body: { ok: true },
    replayed: false,
    execution_started_at: "2026-07-24T18:00:00.000Z",
  },
  rpcError: unknown = null,
) {
  const list = vi.fn().mockResolvedValue({ data: [], error: null });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  const storageFrom = vi.fn(() => ({ list, remove }));
  const rpc = vi.fn().mockResolvedValue({
    data: rpcError ? null : [row],
    error: rpcError,
  });
  return {
    rpc,
    list,
    remove,
    supabase: { rpc, storage: { from: storageFrom } },
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

function makeMethodReq(
  method: "PUT" | "DELETE",
  key?: string,
): NextRequest {
  return new Request(`http://localhost/api/restaurant/${R}`, {
    method,
    headers: key ? { "Idempotency-Key": key } : {},
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

  it("preserves keyless compatibility and writes the signed cookie", async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });
    mockVerifyActiveRestaurantMembership.mockResolvedValue({ ok: true });

    const res = await PUT(makeMethodReq("PUT"), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restaurantId: R });
    expect(res.headers.get("Idempotency-Replayed")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain(
      "active_restaurant_id=",
    );
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(mockVerifyActiveRestaurantMembership).toHaveBeenCalledWith(
      supabase,
      "u-1",
      R,
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("claims with the full validated parameter identity", async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });
    mockVerifyActiveRestaurantMembership.mockResolvedValue({ ok: true });

    const res = await PUT(makeMethodReq("PUT", KEY), { params });

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBe("false");
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      {
        p_restaurant_id: R,
        p_operation_id: "api:PUT:/api/restaurant/{param}",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({ id: R }),
      },
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: R,
        p_operation_id: "api:PUT:/api/restaurant/{param}",
        p_idempotency_key: KEY,
        p_response_status: 200,
        p_response_body: { ok: true, restaurantId: R },
      }),
    );
  });

  it("canonicalizes UUID casing for the claim, response, and cookie", async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });
    mockVerifyActiveRestaurantMembership.mockResolvedValue({ ok: true });

    const res = await PUT(makeMethodReq("PUT", KEY), {
      params: Promise.resolve({ id: R.toUpperCase() }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restaurantId: R });
    expect(mockVerifyActiveRestaurantMembership).toHaveBeenCalledWith(
      supabase,
      "u-1",
      R,
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: R,
        p_request_hash: createIdempotencyRequestHash({ id: R }),
      }),
    );
    expect(res.headers.get("set-cookie")).toContain(
      "active_restaurant_id=",
    );
  });

  it("replays a lost first response and reapplies the signed cookie", async () => {
    const supabase = makeSupabase(null, {
      outcome: "replay",
      response_status: 200,
      response_body: { ok: true, restaurantId: R },
      response_headers: {},
    });
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });

    const res = await PUT(makeMethodReq("PUT", KEY), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restaurantId: R });
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    expect(res.headers.get("set-cookie")).toContain(
      "active_restaurant_id=",
    );
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(mockVerifyActiveRestaurantMembership).toHaveBeenCalledWith(
      supabase,
      "u-1",
      R,
    );
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed key before membership verification or claim", async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });

    const res = await PUT(makeMethodReq("PUT", "bad key!"), {
      params,
    });

    expect(res.status).toBe(400);
    expect(mockVerifyActiveRestaurantMembership).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["keyless", undefined],
    ["keyed", KEY],
  ])("returns a fixed 403 for a non-member (%s)", async (_mode, key) => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });
    mockVerifyActiveRestaurantMembership.mockResolvedValue({
      ok: false,
      reason: "not_member",
    });

    const res = await PUT(makeMethodReq("PUT", key), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Not a member of this restaurant.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("redacts active-membership provider failures", async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({
      supabase,
      user: { id: "u-1" },
    });
    mockVerifyActiveRestaurantMembership.mockResolvedValue({
      ok: false,
      reason: "provider_error",
      cause: { message: "private provider detail" },
    });

    const res = await PUT(makeMethodReq("PUT"), { params });

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

  it("preserves keyless compatibility through the atomic delete RPC", async () => {
    const db = makeSupabaseForDelete();
    mockRequireAuth.mockResolvedValue({
      supabase: db.supabase,
      user: { id: "u-1" },
    });
    mockResolveActiveMembership.mockResolvedValue({
      restaurantId: R,
      restaurantName: "Restaurant",
      role: "owner",
      availableRestaurants: [],
    });

    const res = await DELETE(makeMethodReq("DELETE"), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Idempotency-Replayed")).toBeNull();
    expect(db.rpc).toHaveBeenCalledWith(
      "delete_restaurant_idempotent",
      {
        p_restaurant_id: R,
        p_active_restaurant_id: R,
      },
    );
    expect(db.list).toHaveBeenCalledWith(R, {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });
  });

  it("binds a keyed delete to its full validated parameter identity", async () => {
    const db = makeSupabaseForDelete();
    mockRequireAuth.mockResolvedValue({
      supabase: db.supabase,
      user: { id: "u-1" },
    });
    mockResolveActiveMembership.mockResolvedValue({
      restaurantId: R,
      restaurantName: "Restaurant",
      role: "owner",
      availableRestaurants: [],
    });

    const res = await DELETE(makeMethodReq("DELETE", KEY), { params });

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBe("false");
    expect(db.rpc).toHaveBeenCalledWith(
      "delete_restaurant_idempotent",
      {
        p_restaurant_id: R,
        p_active_restaurant_id: R,
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({ id: R }),
      },
    );
  });

  it("replays exact success after deletion has removed every membership", async () => {
    const db = makeSupabaseForDelete({
      outcome: "replay",
      response_status: 200,
      response_body: { ok: true },
      replayed: true,
      execution_started_at: "2026-07-24T18:00:00.000Z",
    });
    mockRequireAuth.mockResolvedValue({
      supabase: db.supabase,
      user: { id: "u-1" },
    });
    mockResolveActiveMembership.mockResolvedValue(null);

    const res = await DELETE(makeMethodReq("DELETE", KEY), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    expect(db.rpc).toHaveBeenCalledWith(
      "delete_restaurant_idempotent",
      expect.objectContaining({
        p_restaurant_id: R,
        p_idempotency_key: KEY,
      }),
    );
    expect(db.rpc.mock.calls[0]?.[1]).not.toHaveProperty(
      "p_active_restaurant_id",
    );
  });

  it("rejects malformed keys before active-membership or database work", async () => {
    const db = makeSupabaseForDelete();
    mockRequireAuth.mockResolvedValue({
      supabase: db.supabase,
      user: { id: "u-1" },
    });

    const res = await DELETE(
      makeMethodReq("DELETE", "bad key!"),
      { params },
    );

    expect(res.status).toBe(400);
    expect(mockResolveActiveMembership).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["no_membership", "No restaurant membership found."],
    ["owner_required", "Owner access required."],
    ["forbidden", "Forbidden."],
  ] as const)(
    "preserves the %s authorization response",
    async (outcome, message) => {
      const db = makeSupabaseForDelete({
        outcome,
        response_status: 403,
        response_body: {
          error: { code: "forbidden", message },
        },
        replayed: false,
        execution_started_at: "2026-07-24T18:00:00.000Z",
      });
      mockRequireAuth.mockResolvedValue({
        supabase: db.supabase,
        user: { id: "u-1" },
      });
      mockResolveActiveMembership.mockResolvedValue(null);

      const res = await DELETE(makeMethodReq("DELETE"), { params });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "forbidden", message },
      });
    },
  );

  it("fails closed and redacts keyed delete provider failures", async () => {
    const db = makeSupabaseForDelete(
      undefined,
      { code: "XX000", message: "private delete detail" },
    );
    mockRequireAuth.mockResolvedValue({
      supabase: db.supabase,
      user: { id: "u-1" },
    });
    mockResolveActiveMembership.mockResolvedValue({
      restaurantId: R,
      restaurantName: "Restaurant",
      role: "owner",
      availableRestaurants: [],
    });

    const res = await DELETE(makeMethodReq("DELETE", KEY), { params });

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("private");
  });
});
