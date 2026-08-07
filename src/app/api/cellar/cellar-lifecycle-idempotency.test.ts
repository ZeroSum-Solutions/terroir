import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: vi.fn(() => ({
    drinkWindowStart: null,
    drinkWindowEnd: null,
    peakYear: null,
    ratingSource: null,
    reviewExcerpt: null,
    servingTempMin: null,
    servingTempMax: null,
    servingTempLabel: null,
    decantMinutes: null,
  })),
}));

const { POST } = await import("./route");
const { DELETE } = await import("./[id]/route");

const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const WINE_ID = "11111111-1111-4111-8111-111111111111";
const INVENTORY_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "cellar-lifecycle-key";

const addPayload = {
  name: "Reserve",
  producer: "Domaine Test",
  quantity: 3,
  unit_cost: 25,
};

function addRequest(key = KEY) {
  return new NextRequest("http://localhost/api/cellar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(addPayload),
  });
}

function deleteRequest(key = KEY) {
  return new NextRequest(`http://localhost/api/cellar/${WINE_ID}`, {
    method: "DELETE",
    headers: key ? { "Idempotency-Key": key } : undefined,
  });
}

function allowRole(
  rpc: ReturnType<typeof vi.fn>,
  from = vi.fn(),
  storage = {
    from: vi.fn(() => ({
      remove: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
  },
) {
  auth.requireRole.mockResolvedValue({
    restaurantId: RESTAURANT_ID,
    role: "owner",
    supabase: { rpc, from, storage },
  });
  return from;
}

describe("cellar lifecycle idempotency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replays a normalized keyed cellar add without running post-write work", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        outcome: "replay",
        response_status: 200,
        response_body: {
          wineId: WINE_ID,
          inventoryId: INVENTORY_ID,
          quantity: 3,
          unitCost: 25,
        },
        replayed: true,
      }],
      error: null,
    }));
    const from = allowRole(rpc, vi.fn(() => {
      throw new Error("replayed add must not load or enrich a wine");
    }));

    const response = await POST(addRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual({
      wineId: WINE_ID,
      inventoryId: INVENTORY_ID,
      quantity: 3,
      unitCost: 25,
    });
    expect(rpc).toHaveBeenCalledWith("add_cellar_wine_idempotent", {
      p_restaurant_id: RESTAURANT_ID,
      p_name: "Reserve",
      p_producer: "Domaine Test",
      p_vintage: undefined,
      p_varietal: undefined,
      p_region: undefined,
      p_country: undefined,
      p_quantity: 3,
      p_unit_cost: 25,
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash({
        body: {
          country: null,
          name: "Reserve",
          producer: "Domaine Test",
          quantity: 3,
          region: null,
          unit_cost: 25,
          varietal: null,
          vintage: null,
        },
      }),
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("fails closed when a keyed cellar add RPC rejects its canonical identity", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "22023", message: "hash mismatch" },
    }));
    allowRole(rpc);

    const response = await POST(addRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_cellar_add_request" },
    });
  });

  it("replays a keyed cellar deletion without rerunning its dependency checks", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        outcome: "replay",
        response_status: 200,
        response_body: { deleted: true },
        replayed: true,
      }],
      error: null,
    }));
    const from = allowRole(rpc, vi.fn(() => {
      throw new Error("replayed delete must not query tables");
    }));

    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual({ deleted: true });
    expect(rpc).toHaveBeenCalledWith("delete_cellar_wine_idempotent", {
      p_restaurant_id: RESTAURANT_ID,
      p_wine_id: WINE_ID,
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash({ id: WINE_ID }),
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects invalid keys before either cellar lifecycle RPC", async () => {
    const rpc = vi.fn();
    allowRole(rpc);

    const [add, remove] = await Promise.all([
      POST(addRequest("bad key")),
      DELETE(deleteRequest("bad key"), {
        params: Promise.resolve({ id: WINE_ID }),
      }),
    ]);

    expect(add.status).toBe(400);
    expect(remove.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
