import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({ requireCapability: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireCapability(...args),
}));

const { PATCH } = await import("./route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "restaurant_root_patch_0001";

function request(body: unknown, key?: string) {
  return new NextRequest("http://localhost/api/restaurant", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

function database(
  updateError: unknown = null,
  claim: unknown = [{ outcome: "claimed" }],
) {
  const updates: unknown[] = [];
  const filters: Array<[string, unknown]> = [];
  const updateQuery = {
    update: vi.fn((payload: unknown) => {
      updates.push(payload);
      return updateQuery;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push([column, value]);
      return Promise.resolve({ error: updateError });
    }),
  };
  const from = vi.fn(() => updateQuery);
  const rpc = vi.fn((name: string) => {
    if (name === "claim_api_idempotency") {
      return Promise.resolve({ data: claim, error: null });
    }
    if (name === "complete_api_idempotency") {
      return Promise.resolve({ data: true, error: null });
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { client: { from, rpc }, from, rpc, updates, filters };
}

function authorize(client: unknown) {
  auth.requireCapability.mockResolvedValue({
    supabase: client,
    restaurantId: RESTAURANT_ID,
    user: { id: "22222222-2222-4222-8222-222222222222" },
    role: "owner",
  });
}

describe("PATCH /api/restaurant compatibility handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the exact authorization denial before parsing the body", async () => {
    const denial = NextResponse.json(
      { error: { code: "forbidden", message: "Forbidden" } },
      { status: 403 },
    );
    auth.requireCapability.mockResolvedValue(denial);

    const response = await PATCH(request({ name: "Bistro" }));

    expect(response).toBe(denial);
  });

  it("rejects malformed metadata before database work", async () => {
    const db = database();
    authorize(db.client);

    const response = await PATCH(request({ eightysix_ml_threshold: -1 }));

    expect(response.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("updates only the active restaurant and binds keyed retries to the exact path", async () => {
    const db = database();
    authorize(db.client);
    const body = {
      name: "Bistro",
      auto_eightysix_from_inventory: true,
      eightysix_strategy: "mark",
    };

    const response = await PATCH(request(body, KEY));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(db.updates).toEqual([body]);
    expect(db.filters).toEqual([["id", RESTAURANT_ID]]);
    expect(db.rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: RESTAURANT_ID,
      p_operation_id: "api:PATCH:/api/restaurant",
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash(body),
    });
  });

  it("redacts database failures", async () => {
    const db = database({ message: "private provider detail" });
    authorize(db.client);

    const response = await PATCH(request({ name: "Bistro" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("replays a keyed success without repeating the update", async () => {
    const db = database(null, [
      {
        outcome: "replay",
        response_status: 200,
        response_headers: {},
        response_body: { ok: true },
      },
    ]);
    authorize(db.client);

    const response = await PATCH(request({ name: "Bistro" }, KEY));

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(db.updates).toEqual([]);
  });
});
