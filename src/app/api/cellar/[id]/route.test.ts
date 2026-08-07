import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH, DELETE } = await import("./route");

const INVENTORY_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const WINE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
const KEY = "cellar-item-command-key-0001";
const RESTAURANT_ID = "restaurant-a";

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

type CellarDeleteRow = {
  outcome: string;
  response_status: number;
  response_body: unknown;
  replayed: boolean;
};

function request(body: unknown, key?: string): NextRequest {
  return new Request(`http://localhost/api/cellar/${INVENTORY_ID}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeSupabase(options: {
  inventoryUpdate?: {
    data: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
  };
  wineLookup?: {
    data: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
  };
  claimRow?: ClaimRow;
  cellarDelete?: {
    data: CellarDeleteRow[] | null;
    error: { code?: string; message?: string } | null;
  };
  storageRemoveError?: { message: string } | null;
} = {}) {
  const claimRow = options.claimRow ?? {
    outcome: "claimed",
    response_status: null,
    response_body: null,
    response_headers: null,
  };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const remove = vi.fn(async () => ({
    data: [],
    error: options.storageRemoveError ?? null,
  }));
  const storageFrom = vi.fn(() => ({ remove }));
  const rpc = vi.fn(async (operation: string) => {
    if (operation === "claim_api_idempotency") {
      return { data: [claimRow], error: null };
    }
    if (operation === "delete_cellar_wine_idempotent") {
      return options.cellarDelete ?? {
        data: [{
          outcome: "not_found",
          response_status: 404,
          response_body: {
            error: { code: "not_found", message: "Wine not found." },
          },
          replayed: false,
        }],
        error: null,
      };
    }
    if (
      operation === "complete_api_idempotency" ||
      operation === "fail_api_idempotency" ||
      operation === "release_api_idempotency"
    ) {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${operation}`);
  });
  const from = vi.fn((table: string) => {
    calls.push({ method: "from", args: [table] });
    if (table === "inventory_items") {
      return {
        update: (payload: Record<string, unknown>) => {
          calls.push({ method: "update", args: [payload] });
          return {
            eq: (column: string, value: string) => {
              calls.push({ method: "eq", args: [column, value] });
              return {
                eq: (nextColumn: string, nextValue: string) => {
                  calls.push({
                    method: "eq",
                    args: [nextColumn, nextValue],
                  });
                  return {
                    select: (columns: string) => {
                      calls.push({ method: "select", args: [columns] });
                      return {
                        single: async () =>
                          options.inventoryUpdate ?? {
                            data: {
                              id: INVENTORY_ID,
                              quantity: payload.quantity,
                              unit_cost: payload.unit_cost ?? null,
                              bin_location: payload.bin_location,
                            },
                            error: null,
                          },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    }
    if (table === "wines") {
      return {
        select: (columns: string) => {
          calls.push({ method: "select", args: [columns] });
          return {
            eq: (column: string, value: string) => {
              calls.push({ method: "eq", args: [column, value] });
              return {
                eq: (nextColumn: string, nextValue: string) => {
                  calls.push({
                    method: "eq",
                    args: [nextColumn, nextValue],
                  });
                  return {
                    single: async () =>
                      options.wineLookup ?? { data: null, error: null },
                  };
                },
              };
            },
          };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return {
    from,
    calls,
    rpc,
    storage: { from: storageFrom },
    remove,
  };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "user-a" },
    role: "owner",
  });
}

async function expectValidationError(response: Response, path: string[]) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: "validation_error",
      details: [{ path }],
    },
  });
}

describe("PATCH /api/cellar/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorizes before reading malformed params or body", async () => {
    const text = vi.fn();
    const supabase = makeSupabase();
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "denied" }, { status: 401 }),
    );

    const response = await PATCH({ text } as unknown as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(401);
    expect(text).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid UUID before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ quantity: 2 }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    await expectValidationError(response, ["id"]);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request("{not-json"), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid known fields before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ quantity: -1 }), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    await expectValidationError(response, ["quantity"]);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects an empty normalized update before an idempotency claim", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ ignored_client_field: true }, KEY),
      { params: Promise.resolve({ id: INVENTORY_ID }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message: "No valid fields to update.",
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("preserves the exact keyless response without idempotency RPCs", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ quantity: 4, bin_location: "  A-2  " }),
      { params: Promise.resolve({ id: INVENTORY_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual({
      id: INVENTORY_ID,
      quantity: 4,
      unit_cost: null,
      bin_location: "A-2",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before a claim or inventory update", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ quantity: 4 }, "bad key!"),
      { params: Promise.resolve({ id: INVENTORY_ID }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("claims the canonical normalized command, updates once, and completes", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request(
        {
          quantity: 4,
          unit_cost: 18.5,
          bin_location: "  A-2  ",
          ignored_client_field: true,
        },
        KEY,
      ),
      { params: Promise.resolve({ id: INVENTORY_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:PATCH:/api/cellar/{param}",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          id: INVENTORY_ID,
          quantity: 4,
          unit_cost: 18.5,
          bin_location: "A-2",
        }),
      },
    );
    expect(
      supabase.calls.filter((call) => call.method === "update"),
    ).toEqual([
      {
        method: "update",
        args: [
          {
            quantity: 4,
            unit_cost: 18.5,
            bin_location: "A-2",
          },
        ],
      },
    ]);
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:PATCH:/api/cellar/{param}",
        p_idempotency_key: KEY,
        p_response_status: 200,
        p_response_body: {
          id: INVENTORY_ID,
          quantity: 4,
          unit_cost: 18.5,
          bin_location: "A-2",
        },
      }),
    );
  });

  it("replays a completed response without another inventory update", async () => {
    const replayBody = {
      id: INVENTORY_ID,
      quantity: 4,
      unit_cost: 18.5,
      bin_location: "A-2",
    };
    const supabase = makeSupabase({
      claimRow: {
        outcome: "replay",
        response_status: 200,
        response_body: replayBody,
        response_headers: {},
      },
    });
    allow(supabase);

    const response = await PATCH(
      request(
        {
          quantity: 4,
          unit_cost: 18.5,
          bin_location: "A-2",
        },
        KEY,
      ),
      { params: Promise.resolve({ id: INVENTORY_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves stripping of unknown keys and tenant-scoped updates", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({
        quantity: 4,
        bin_location: "  A-2  ",
        ignored_client_field: true,
      }),
      { params: Promise.resolve({ id: INVENTORY_ID }) },
    );

    expect(response.status).toBe(200);
    expect(supabase.calls).toContainEqual({
      method: "update",
      args: [{ quantity: 4, bin_location: "A-2" }],
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["id", INVENTORY_ID],
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["restaurant_id", RESTAURANT_ID],
    });
  });

  it("returns 404 when the tenant-scoped inventory item is missing", async () => {
    const supabase = makeSupabase({
      inventoryUpdate: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ quantity: 2 }), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Inventory item not found.",
      },
    });
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("completes a deterministic tenant-scoped 404 for keyed replay", async () => {
    const supabase = makeSupabase({
      inventoryUpdate: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ quantity: 2 }, KEY), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Inventory item not found.",
      },
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:PATCH:/api/cellar/{param}",
        p_response_status: 404,
        p_response_body: {
          error: {
            code: "not_found",
            message: "Inventory item not found.",
          },
        },
      }),
    );
  });

  it("returns 500 when the inventory update provider fails", async () => {
    const supabase = makeSupabase({
      inventoryUpdate: {
        data: null,
        error: { code: "08006", message: "connection failure" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ quantity: 2 }), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Update failed.",
      },
    });
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when a keyed inventory update provider call fails", async () => {
    const supabase = makeSupabase({
      inventoryUpdate: {
        data: null,
        error: { code: "08006", message: "connection failure" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ quantity: 2 }, KEY), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "fail_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:PATCH:/api/cellar/{param}",
        p_idempotency_key: KEY,
      }),
    );
  });
});

describe("DELETE /api/cellar/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves owner authorization precedence for malformed params", async () => {
    const supabase = makeSupabase();
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "denied" }, { status: 403 }),
    );

    const response = await DELETE({} as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith(["owner"]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid UUID before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await DELETE({} as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    await expectValidationError(response, ["id"]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("preserves the tenant-scoped missing-wine response for a valid UUID", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await DELETE(
      new NextRequest(`http://localhost/api/cellar/${WINE_ID}`, {
        method: "DELETE",
      }),
      {
      params: Promise.resolve({ id: WINE_ID }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Wine not found." },
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "delete_cellar_wine_idempotent",
      expect.objectContaining({
        p_restaurant_id: "restaurant-a",
        p_wine_id: WINE_ID,
      }),
    );
    expect(supabase.remove).toHaveBeenCalledWith([
      `${RESTAURANT_ID}/${WINE_ID}.jpg`,
      `${RESTAURANT_ID}/${WINE_ID}.png`,
      `${RESTAURANT_ID}/${WINE_ID}.webp`,
    ]);
  });

  it("returns 500 when the dedicated deletion RPC provider fails", async () => {
    const supabase = makeSupabase({
      cellarDelete: {
        data: null,
        error: { code: "08006", message: "connection failure" },
      },
    });
    allow(supabase);

    const response = await DELETE(
      new NextRequest(`http://localhost/api/cellar/${WINE_ID}`, {
        method: "DELETE",
      }),
      {
      params: Promise.resolve({ id: WINE_ID }),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });
});
