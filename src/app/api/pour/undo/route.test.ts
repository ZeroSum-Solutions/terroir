import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireMembership = vi.fn();
const mockRevalidateUndonePour = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@/domains/pours/pour-service", () => ({
  revalidateUndonePour: (...args: unknown[]) =>
    mockRevalidateUndonePour(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { POST } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const BOTTLE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
const RESTAURANT_ID = "c1b2c3d4-e5f6-4789-8abc-def012345678";
const KEY = "d1b2c3d4-e5f6-4789-8abc-def012345678";
const STARTED_AT = "2026-07-24T18:00:00.000Z";
const OPEN_BODY = {
  open_bottle: {
    id: BOTTLE_ID,
    wine_id: WINE_ID,
    restaurant_id: RESTAURANT_ID,
    remaining_ml: 602,
    opened_at: "2026-07-24T17:00:00.000Z",
    opened_by: "e1b2c3d4-e5f6-4789-8abc-def012345678",
    source_inventory_item_id: null,
    closed_at: null,
  },
};

function request(options: {
  key?: string;
  body?: unknown;
} = {}): NextRequest {
  return new Request("http://localhost/api/pour/undo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.key ? { "Idempotency-Key": options.key } : {}),
    },
    body: JSON.stringify(options.body ?? { wine_id: WINE_ID }),
  }) as unknown as NextRequest;
}

function makeSupabase(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>,
) {
  const rpc = vi.fn(implementation);
  const from = vi.fn(() => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      gte: () => chain,
      in: () => Promise.resolve({ data: [], error: null }),
    };
    return chain;
  });
  return { rpc, from };
}

function resultClient(row: unknown) {
  return makeSupabase(async (name) => {
    if (name !== "undo_last_pour_idempotent") {
      throw new Error(`unexpected rpc ${name}`);
    }
    return { data: [row], error: null };
  });
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "user-a" },
    role: "staff",
  });
}

function result(
  overrides: Partial<{
    outcome: string;
    response_status: number;
    response_body: unknown;
    replayed: boolean;
    execution_started_at: string;
  }> = {},
) {
  return {
    outcome: "undone",
    response_status: 200,
    response_body: OPEN_BODY,
    replayed: false,
    execution_started_at: STARTED_AT,
    ...overrides,
  };
}

describe("POST /api/pour/undo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevalidateUndonePour.mockResolvedValue(undefined);
  });

  it("preserves auth-first behavior", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      ),
    );

    expect((await POST(request())).status).toBe(401);
  });

  it("rejects a malformed supplied key before any RPC", async () => {
    const supabase = resultClient(result());
    allow(supabase);

    const response = await POST(request({ key: "bad key" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("keeps missing-key compatibility on the dedicated atomic RPC", async () => {
    const supabase = resultClient(result());
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "undo_last_pour_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_id: WINE_ID,
      },
    );
    expect(mockRevalidateUndonePour).toHaveBeenCalledWith({
      supabase,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      sinceTs: STARTED_AT,
    });
  });

  it("binds the key and canonical body hash to the atomic command", async () => {
    const supabase = resultClient(result());
    allow(supabase);
    const uppercaseWineId = WINE_ID.toUpperCase();

    const response = await POST(request({
      key: KEY,
      body: { wine_id: uppercaseWineId },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "undo_last_pour_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_id: WINE_ID,
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          wine_id: WINE_ID,
        }),
      },
    );
  });

  it("replays the exact stored response and original execution timestamp", async () => {
    const supabase = resultClient(
      result({ outcome: "replay", replayed: true }),
    );
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(mockRevalidateUndonePour).toHaveBeenCalledWith(
      expect.objectContaining({ sinceTs: STARTED_AT }),
    );
  });

  it("returns the exact missing-pour response for keyless compatibility", async () => {
    const body = {
      error: {
        code: "not_found",
        message: "Pour to undo not found.",
      },
    };
    const supabase = resultClient(
      result({
        outcome: "not_found",
        response_status: 404,
        response_body: body,
      }),
    );
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(mockRevalidateUndonePour).not.toHaveBeenCalled();
  });

  it("stores deterministic keyed not-found responses", async () => {
    const body = {
      error: {
        code: "not_found",
        message: "Pour to undo not found.",
      },
    };
    const supabase = resultClient(
      result({
        outcome: "not_found",
        response_status: 404,
        response_body: body,
      }),
    );
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
  });

  it("returns the exact in-progress envelope and retry hint", async () => {
    const body = {
      error: {
        code: "idempotency_in_progress",
        message:
          "A request with this Idempotency-Key is still in progress.",
      },
    };
    const supabase = resultClient(
      result({
        outcome: "idempotency_in_progress",
        response_status: 409,
        response_body: body,
      }),
    );
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual(body);
  });

  it.each([
    [
      "idempotency_key_reused",
      "This Idempotency-Key was already used for a different request.",
    ],
    [
      "idempotency_key_expired",
      "This Idempotency-Key has expired.",
    ],
    [
      "idempotency_outcome_unknown",
      "The original request outcome is unknown and will not be retried.",
    ],
  ] as const)("passes through %s without a replay header", async (outcome, message) => {
    const body = { error: { code: outcome, message } };
    const supabase = resultClient(
      result({
        outcome,
        response_status: 409,
        response_body: body,
      }),
    );
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("preserves the RPC permission failure", async () => {
    const supabase = makeSupabase(async () => ({
      data: null,
      error: { code: "42501", message: "forbidden" },
    }));
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Forbidden." },
    });
  });

  it("preserves the keyless unknown-provider response", async () => {
    const supabase = makeSupabase(async () => ({
      data: null,
      error: { code: "XX000", message: "provider failed" },
    }));
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Undo failed." },
    });
  });

  it("fails keyed provider errors closed as an ambiguous outcome", async () => {
    const error = { code: "XX000", message: "provider failed" };
    const supabase = makeSupabase(async () => ({ data: null, error }));
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: { surface: "pour", phase: "undo-idempotent-rpc" },
      }),
    );
  });

  it("treats keyed database identity validation as a terminal request error", async () => {
    const error = {
      code: "22023",
      message: "request hash does not match the canonical undo identity",
    };
    const supabase = makeSupabase(async () => ({ data: null, error }));
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_undo_request",
        message: "Invalid undo request.",
      },
    });
  });

  it("rejects malformed keyed results without guessing the outcome", async () => {
    const supabase = resultClient(
      result({ execution_started_at: "not-a-timestamp" }),
    );
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
  });

  it.each([
    [
      "outcome/status mismatch",
      result({ response_status: 404 }),
    ],
    [
      "wrong response wine",
      result({
        response_body: {
          open_bottle: {
            ...OPEN_BODY.open_bottle,
            wine_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          },
        },
      }),
    ],
    [
      "wrong response restaurant",
      result({
        response_body: {
          open_bottle: {
            ...OPEN_BODY.open_bottle,
            restaurant_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          },
        },
      }),
    ],
    [
      "wrong deterministic error code",
      result({
        outcome: "not_found",
        response_status: 404,
        response_body: {
          error: { code: "other", message: "Wrong envelope." },
        },
      }),
    ],
  ])("rejects a keyed %s", async (_label, invalidResult) => {
    const supabase = resultClient(invalidResult);
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
  });

  it("rejects a keyless idempotency classification", async () => {
    const supabase = resultClient(
      result({
        outcome: "idempotency_in_progress",
        response_status: 409,
        response_body: {
          error: {
            code: "idempotency_in_progress",
            message: "Still running.",
          },
        },
      }),
    );
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error" },
    });
  });

  it("does not replace a committed response when revalidation fails", async () => {
    const supabase = resultClient(result());
    const error = new Error("revalidation unavailable");
    mockRevalidateUndonePour.mockRejectedValue(error);
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: { surface: "pour", phase: "undo-revalidate" },
      }),
    );
  });
});
