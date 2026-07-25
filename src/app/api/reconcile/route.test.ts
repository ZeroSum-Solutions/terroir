import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

const { POST } = await import("./route");

type ResultRow = {
  outcome: string;
  response_status: number;
  response_body: unknown;
  replayed: boolean;
};

type RpcCall = { fn: string; args: Record<string, unknown> };
const EXECUTION_STARTED_AT = "2026-07-24T18:00:00.123Z";

function makeSupabase(options: {
  result?: ResultRow;
  error?: { code?: string; message?: string };
  autoEightysixedWineIds?: string[];
  publishedSlugs?: Array<{ slug: string }>;
}) {
  const calls: RpcCall[] = [];
  const gte = vi.fn();
  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "reconcile_open_bottles_idempotent") {
      return Promise.resolve({
        data: options.error
          ? null
          : [{
              execution_started_at: EXECUTION_STARTED_AT,
              ...(options.result ?? successResult(1)),
            }],
        error: options.error ?? null,
      });
    }
    if (fn === "wine_published_list_slugs") {
      return Promise.resolve({
        data: options.publishedSlugs ?? [],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const from = vi.fn((table: string) => {
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      is: () => thenable,
      gte: (...args: unknown[]) => {
        gte(...args);
        return thenable;
      },
      in: () => thenable,
      then: (resolve: (value: unknown) => void) => {
        resolve(
          table === "availability_events"
            ? {
                data: (options.autoEightysixedWineIds ?? []).map(
                  (wine_id) => ({ wine_id }),
                ),
                error: null,
              }
            : { data: null, error: null },
        );
      },
    };
    return thenable;
  });
  return { supabase: { rpc, from }, calls, gte };
}

function successResult(updated: number): ResultRow {
  return {
    outcome: "reconciled",
    response_status: 200,
    response_body: { updated },
    replayed: false,
  };
}

function makeRequest(
  body: unknown,
  key?: string,
): NextRequest {
  return new Request("http://localhost/api/reconcile", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function authenticate(supabase: unknown) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "58100000-0000-4000-8000-000000000001",
    user: { id: "58000000-0000-4000-8000-000000000001" },
    role: "manager",
  });
}

const UUID_A = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const UUID_B = "b1b2c3d4-e5f6-4789-8abc-def012345679";
const KEY = "reconcile_key_0062";

describe("POST /api/reconcile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates before parsing or claiming", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await POST(makeRequest({ entries: [] }, KEY));

    expect(response.status).toBe(401);
  });

  it("role-gates staff before parsing or claiming", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }, KEY),
    );

    expect(response.status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("validates the complete body before inspecting the key", async () => {
    const { supabase, calls } = makeSupabase({});
    authenticate(supabase);

    const response = await POST(makeRequest({ entries: [] }, "bad key!"));

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects a malformed key after body validation and before the RPC", async () => {
    const { supabase, calls } = makeSupabase({});
    authenticate(supabase);

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }, "bad key!"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(calls).toEqual([]);
  });

  it("sends normalized ordered entries and the exact canonical framed hash", async () => {
    const { supabase, calls } = makeSupabase({
      result: successResult(2),
    });
    authenticate(supabase);
    const entries = [
      {
        wine_id: UUID_A.toUpperCase(),
        new_remaining_ml: 375,
        note: "  counted at close  ",
      },
      { wine_id: UUID_B, new_remaining_ml: 0 },
    ];

    const response = await POST(makeRequest({ entries }, KEY));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: 2 });
    const normalizedEntries = [
      {
        wine_id: UUID_A,
        new_remaining_ml: 375,
        note: "counted at close",
      },
      { wine_id: UUID_B, new_remaining_ml: 0 },
    ];
    expect(calls[0]).toEqual({
      fn: "reconcile_open_bottles_idempotent",
      args: {
        p_restaurant_id: "58100000-0000-4000-8000-000000000001",
        p_entries: normalizedEntries,
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          entries: normalizedEntries,
        }),
      },
    });
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
  });

  it("keeps keyless compatibility on the same dedicated atomic RPC", async () => {
    const { supabase, calls } = makeSupabase({
      result: successResult(1),
    });
    authenticate(supabase);

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0].fn).toBe("reconcile_open_bottles_idempotent");
    expect(calls[0].args).not.toHaveProperty("p_idempotency_key");
    expect(calls[0].args).not.toHaveProperty("p_request_hash");
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
  });

  it.each([
    {
      outcome: "exceeds_size",
      status: 400,
      body: {
        error: {
          code: "EXCEEDS_SIZE",
          message: "new_remaining_ml exceeds bottle size.",
        },
      },
    },
    {
      outcome: "not_found",
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: "Open bottle not found.",
        },
      },
    },
  ])("returns and marks a fresh deterministic $status response", async ({
    outcome,
    status,
    body,
  }) => {
    const { supabase } = makeSupabase({
      result: {
        outcome,
        response_status: status,
        response_body: body,
        replayed: false,
      },
    });
    authenticate(supabase);

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 20000 }],
      }, KEY),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it.each([
    [200, { updated: 1 }],
    [
      400,
      {
        error: {
          code: "EXCEEDS_SIZE",
          message: "new_remaining_ml exceeds bottle size.",
        },
      },
    ],
    [
      404,
      {
        error: {
          code: "not_found",
          message: "Open bottle not found.",
        },
      },
    ],
  ])("replays an exact stored %i response", async (status, body) => {
    const { supabase } = makeSupabase({
      result: {
        outcome: "replay",
        response_status: status,
        response_body: body,
        replayed: true,
      },
    });
    authenticate(supabase);

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }, KEY),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("returns Retry-After for an in-progress key", async () => {
    const { supabase } = makeSupabase({
      result: {
        outcome: "idempotency_in_progress",
        response_status: 409,
        response_body: {
          error: {
            code: "idempotency_in_progress",
            message: "A request with this Idempotency-Key is still in progress.",
          },
        },
        replayed: false,
      },
    });
    authenticate(supabase);

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }, KEY),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("fails keyed provider and malformed-result responses closed", async () => {
    const provider = makeSupabase({
      error: { code: "XX000", message: "completion failed" },
    });
    authenticate(provider.supabase);
    const requestBody = {
      entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
    };
    const providerResponse = await POST(makeRequest(requestBody, KEY));
    expect(providerResponse.status).toBe(503);

    const malformed = makeSupabase({
      result: {
        outcome: "reconciled",
        response_status: 200,
        response_body: { updated: 2 },
        replayed: false,
      },
    });
    authenticate(malformed.supabase);
    const malformedResponse = await POST(makeRequest(requestBody, KEY));
    expect(malformedResponse.status).toBe(503);
  });

  it("makes a keyed canonicalization rejection terminal", async () => {
    const invalid = makeSupabase({
      error: { code: "22023", message: "invalid request hash" },
    });
    authenticate(invalid.supabase);

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }, KEY),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_reconcile_request",
        message: "Invalid reconcile request.",
      },
    });
  });

  it("preserves keyless 403 and 500 compatibility", async () => {
    const forbidden = makeSupabase({
      error: { code: "42501", message: "forbidden" },
    });
    authenticate(forbidden.supabase);
    const requestBody = {
      entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
    };

    expect((await POST(makeRequest(requestBody))).status).toBe(403);

    const unknown = makeSupabase({
      error: { code: "XX000", message: "provider failure" },
    });
    authenticate(unknown.supabase);
    expect((await POST(makeRequest(requestBody))).status).toBe(500);
  });

  it("best-effort revalidation cannot replace a committed response", async () => {
    const { supabase } = makeSupabase({
      result: successResult(1),
      autoEightysixedWineIds: [UUID_A],
      publishedSlugs: [{ slug: "dinner-menu" }],
    });
    authenticate(supabase);
    mockRevalidate.mockImplementation(() => {
      throw new Error("cache unavailable");
    });

    const response = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 0 }],
      }, KEY),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: 1 });
  });

  it("revalidates published lists affected by a committed batch", async () => {
    const { supabase, calls, gte } = makeSupabase({
      result: successResult(2),
      autoEightysixedWineIds: [UUID_B],
      publishedSlugs: [{ slug: "dinner-menu" }],
    });
    authenticate(supabase);

    const response = await POST(
      makeRequest({
        entries: [
          { wine_id: UUID_A, new_remaining_ml: 375 },
          { wine_id: UUID_B, new_remaining_ml: 0 },
        ],
      }, KEY),
    );

    expect(response.status).toBe(200);
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
    expect(mockRevalidate).toHaveBeenCalledWith("/list/dinner-menu");
    expect(gte).toHaveBeenCalledWith(
      "created_at",
      EXECUTION_STARTED_AT,
    );
    expect(
      calls.filter(({ fn }) => fn === "wine_published_list_slugs"),
    ).toHaveLength(1);
  });
});
