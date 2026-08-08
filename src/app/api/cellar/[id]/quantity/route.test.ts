import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH } = await import("./route");

const WINE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
const RESTAURANT_ID = "c1b2c3d4-e5f6-4789-8abc-def012345678";
const KEY = "quantity-adjustment-command-0001";

function request(body: unknown, key?: string) {
  return new Request(`http://localhost/api/cellar/${WINE_ID}/quantity`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function allow(result?: {
  data: unknown;
  error: { code?: string; message?: string } | null;
}) {
  const rpc = vi.fn(async () =>
    result ?? {
      data: [
        {
          outcome: "adjusted",
          response_status: 200,
          response_body: {
            wineId: WINE_ID,
            quantity: 3,
            previousQuantity: 2,
            delta: 1,
            reason: "Physical count",
          },
          replayed: false,
        },
      ],
      error: null,
    },
  );
  mockRequireRole.mockResolvedValue({
    supabase: { rpc },
    restaurantId: RESTAURANT_ID,
    user: { id: "user-a" },
    role: "manager",
  });
  return rpc;
}

describe("PATCH /api/cellar/[id]/quantity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorizes before parsing input and denies staff", async () => {
    const text = vi.fn();
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: { code: "forbidden" } }, { status: 403 }),
    );
    const response = await PATCH({ text } as unknown as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(response.status).toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("requires a non-empty reason and a non-negative integer quantity", async () => {
    const rpc = allow();
    const missingReason = await PATCH(request({ quantity: 2, reason: "  " }), {
      params: Promise.resolve({ id: WINE_ID }),
    });
    expect(missingReason.status).toBe(400);
    const negative = await PATCH(request({ quantity: -1, reason: "Count" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });
    expect(negative.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes only the active tenant and canonical keyed identity to the atomic RPC", async () => {
    const rpc = allow();
    const response = await PATCH(
      request({ quantity: 3, reason: "  Physical count  " }, KEY),
      { params: Promise.resolve({ id: WINE_ID }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(rpc).toHaveBeenCalledWith("adjust_cellar_quantity_idempotent", {
      p_restaurant_id: RESTAURANT_ID,
      p_wine_id: WINE_ID,
      p_quantity: 3,
      p_reason: "Physical count",
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash({
        id: WINE_ID,
        quantity: 3,
        reason: "Physical count",
      }),
    });
  });

  it("maps the RPC authorization guard to forbidden for a cross-tenant wine", async () => {
    const rpc = allow({ data: null, error: { code: "42501", message: "forbidden" } });
    const response = await PATCH(request({ quantity: 3, reason: "Count" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });
    expect(response.status).toBe(403);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("returns a replay marker without creating a second adjustment", async () => {
    allow({
      data: [
        {
          outcome: "replay",
          response_status: 200,
          response_body: {
            wineId: WINE_ID,
            quantity: 3,
            previousQuantity: 2,
            delta: 1,
            reason: "Physical count",
          },
          replayed: true,
        },
      ],
      error: null,
    });
    const response = await PATCH(
      request({ quantity: 3, reason: "Physical count" }, KEY),
      { params: Promise.resolve({ id: WINE_ID }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("fails closed on an invalid provider result", async () => {
    allow({ data: [], error: null });
    const response = await PATCH(request({ quantity: 3, reason: "Count" }, KEY), {
      params: Promise.resolve({ id: WINE_ID }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
  });
});
