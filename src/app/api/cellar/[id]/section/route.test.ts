import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const KEY = "section-command-key-0001";
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

function request(body: unknown, key?: string): NextRequest {
  return new Request(`http://localhost/api/cellar/${WINE_ID}/section`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeSupabase(options: {
  wineLookup?: {
    data: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
  };
  updateResult?: {
    data: Array<{ id: string }> | null;
    error: { message?: string } | null;
  };
  claimRow?: ClaimRow;
} = {}) {
  const wineLookup = options.wineLookup ?? {
    data: { id: WINE_ID },
    error: null,
  };
  const updateResult = options.updateResult ?? {
    data: [{ id: "inventory-a" }],
    error: null,
  };
  const claimRow = options.claimRow ?? {
    outcome: "claimed",
    response_status: null,
    response_body: null,
    response_headers: null,
  };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rpc = vi.fn(async (operation: string) => {
    if (operation === "claim_api_idempotency") {
      return { data: [claimRow], error: null };
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
    if (table === "wines") {
      return {
        select: () => ({
          eq: (column: string, value: string) => {
            calls.push({ method: "eq", args: [column, value] });
            return {
              eq: (nextColumn: string, nextValue: string) => {
                calls.push({
                  method: "eq",
                  args: [nextColumn, nextValue],
                });
                return {
                  single: async () => wineLookup,
                };
              },
            };
          },
        }),
      };
    }
    if (table === "inventory_items") {
      return {
        update: (payload: Record<string, unknown>) => {
          calls.push({ method: "update", args: [payload] });
          const chain = {
            eq: (column: string, value: string) => {
              calls.push({ method: "eq", args: [column, value] });
              return chain;
            },
            select: async (...args: unknown[]) => {
              calls.push({ method: "select", args });
              return updateResult;
            },
          };
          return chain;
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from, calls, rpc };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "user-a" },
    role: "manager",
  });
}

describe("PATCH /api/cellar/[id]/section", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { status: 401 as const, actor: "unauthenticated caller" },
    { status: 403 as const, actor: "staff caller" },
  ])("preserves $actor precedence over invalid input", async ({ status }) => {
    const text = vi.fn();
    const supabase = makeSupabase();
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "denied" }, { status }),
    );

    const response = await PATCH({ text } as unknown as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(status);
    expect(text).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid UUID before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ section: "Reds" }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["id"] }],
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request("{not-json"), {
      params: Promise.resolve({ id: WINE_ID }),
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

    const response = await PATCH(request({ section: "" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["section"] }],
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("preserves keyless behavior without idempotency RPCs", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ section: "Reserve" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual({
      wine_id: WINE_ID,
      section: "Reserve",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before a claim or business lookup", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ section: "Reserve" }, "bad key!"),
      { params: Promise.resolve({ id: WINE_ID }) },
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

  it("claims the canonical params and body, mutates once, and completes", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ section: "  Reserve  " }, KEY),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({
      wine_id: WINE_ID,
      section: "Reserve",
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id:
          "api:PATCH:/api/cellar/{param}/section",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          id: WINE_ID,
          section: "Reserve",
        }),
      },
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id:
          "api:PATCH:/api/cellar/{param}/section",
        p_idempotency_key: KEY,
        p_response_status: 200,
        p_response_body: {
          wine_id: WINE_ID,
          section: "Reserve",
        },
      }),
    );
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it("replays an exact completed 404 without business access", async () => {
    const replayBody = {
      error: { code: "not_found", message: "Wine not found." },
    };
    const supabase = makeSupabase({
      claimRow: {
        outcome: "replay",
        response_status: 404,
        response_body: replayBody,
        response_headers: {},
      },
    });
    allow(supabase);

    const response = await PATCH(
      request({ section: "Reserve" }, KEY),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("replays an exact completed 200 without repeating the move", async () => {
    const replayBody = {
      wine_id: WINE_ID,
      section: "Reserve",
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
      request({ section: "Reserve" }, KEY),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("trims the section and preserves both tenant predicates", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ section: "  Cult Cabs  ", ignored_client_field: true }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      wine_id: WINE_ID,
      section: "Cult Cabs",
    });
    expect(supabase.calls).toContainEqual({
      method: "update",
      args: [{ section: "Cult Cabs" }],
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["wine_id", WINE_ID],
    });
    expect(supabase.calls.filter((call) => call.method === "eq")).toContainEqual({
      method: "eq",
      args: ["restaurant_id", RESTAURANT_ID],
    });
    expect(supabase.calls).toContainEqual({
      method: "select",
      args: ["id"],
    });
  });

  it("clears the section when a wine is dropped into uncategorized", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ section: null }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      wine_id: WINE_ID,
      section: null,
    });
    expect(supabase.calls).toContainEqual({
      method: "update",
      args: [{ section: null }],
    });
  });

  it("returns 404 when the wine has no inventory record to move", async () => {
    const supabase = makeSupabase({
      updateResult: { data: [], error: null },
    });
    allow(supabase);

    const response = await PATCH(request({ section: "Reserve" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Inventory not found.",
      },
    });
  });

  it("returns 500 when the inventory update fails", async () => {
    const supabase = makeSupabase({
      updateResult: {
        data: null,
        error: { message: "provider unavailable" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ section: "Reserve" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to update section.",
      },
    });
  });

  it("returns 404 when the tenant-scoped wine is missing", async () => {
    const supabase = makeSupabase({
      wineLookup: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ section: "Reds" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Wine not found." },
    });
  });

  it("fails closed and marks a keyed provider failure", async () => {
    const supabase = makeSupabase({
      wineLookup: {
        data: null,
        error: { code: "08006", message: "connection failure" },
      },
    });
    allow(supabase);

    const response = await PATCH(request({ section: "Reds" }, KEY), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to find wine.",
      },
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "fail_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id:
          "api:PATCH:/api/cellar/{param}/section",
        p_idempotency_key: KEY,
      }),
    );
  });

  it("preserves the update envelope after marking a keyed failure", async () => {
    const supabase = makeSupabase({
      updateResult: {
        data: null,
        error: { message: "private update detail" },
      },
    });
    allow(supabase);

    const response = await PATCH(
      request({ section: "Reserve" }, KEY),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to update section.",
      },
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "fail_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id:
          "api:PATCH:/api/cellar/{param}/section",
        p_idempotency_key: KEY,
      }),
    );
  });
});
