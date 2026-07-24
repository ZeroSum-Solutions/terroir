import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH, DELETE } = await import("./route");

const INVENTORY_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const WINE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";

function request(body: unknown): NextRequest {
  return new Request(`http://localhost/api/cellar/${INVENTORY_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
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
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
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
                              unit_cost: null,
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
  return { from, calls };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
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
  });

  it("rejects an invalid UUID before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ quantity: 2 }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    await expectValidationError(response, ["id"]);
    expect(supabase.from).not.toHaveBeenCalled();
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
  });

  it("rejects invalid known fields before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ quantity: -1 }), {
      params: Promise.resolve({ id: INVENTORY_ID }),
    });

    await expectValidationError(response, ["quantity"]);
    expect(supabase.from).not.toHaveBeenCalled();
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
      args: ["restaurant_id", "restaurant-a"],
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

    const response = await DELETE({} as NextRequest, {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Wine not found." },
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["id", WINE_ID],
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
  });

  it("returns 500 when the tenant-scoped wine lookup provider fails", async () => {
    const supabase = makeSupabase({
      wineLookup: {
        data: null,
        error: { code: "08006", message: "connection failure" },
      },
    });
    allow(supabase);

    const response = await DELETE({} as NextRequest, {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to find wine.",
      },
    });
  });
});
