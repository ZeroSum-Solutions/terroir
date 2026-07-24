import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockRevalidatePath = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { POST } = await import("./route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const BOTTLE_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const RESTAURANT_ID = "44444444-4444-4444-8444-444444444444";
const OPEN_BODY = {
  open_bottle: {
    id: BOTTLE_ID,
    wine_id: WINE_ID,
    remaining_ml: 750,
    opened_at: "2026-07-24T00:00:00.000Z",
  },
};

function request(options: {
  key?: string;
  body?: unknown;
} = {}): NextRequest {
  return new Request("http://localhost/api/open-bottles", {
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
  return { rpc };
}

function resultClient(row: unknown) {
  return makeSupabase(async (name) => {
    if (name !== "open_bottle_from_inventory_idempotent") {
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

describe("POST /api/open-bottles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const supabase = resultClient({
      outcome: "opened",
      response_status: 201,
      response_body: OPEN_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: "bad key" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("keeps missing-key compatibility on the dedicated atomic RPC", async () => {
    const supabase = resultClient({
      outcome: "opened",
      response_status: 201,
      response_body: OPEN_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "open_bottle_from_inventory_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_id: WINE_ID,
      },
    );
  });

  it("binds the key and canonical request hash to the atomic command", async () => {
    const supabase = resultClient({
      outcome: "opened",
      response_status: 201,
      response_body: OPEN_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "open_bottle_from_inventory_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_id: WINE_ID,
        p_idempotency_key: KEY,
        p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cellar/open");
  });

  it("replays the stored response through the same RPC", async () => {
    const supabase = resultClient({
      outcome: "replay",
      response_status: 201,
      response_body: OPEN_BODY,
      replayed: true,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(OPEN_BODY);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cellar/open");
  });

  it("returns the exact in-progress envelope and retry hint", async () => {
    const supabase = resultClient({
      outcome: "idempotency_in_progress",
      response_status: 409,
      response_body: {
        error: {
          code: "idempotency_in_progress",
          message:
            "A request with this Idempotency-Key is still in progress.",
        },
      },
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        code: "idempotency_in_progress",
        message:
          "A request with this Idempotency-Key is still in progress.",
      },
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
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
    const supabase = resultClient({
      outcome,
      response_status: 409,
      response_body: {
        error: {
          code: outcome,
          message,
        },
      },
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: outcome,
        message,
      },
    });
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "not_found",
      404,
      { error: { code: "not_found", message: "Wine not found." } },
    ],
    [
      "no_sealed_stock",
      409,
      {
        error: {
          code: "no_sealed_stock",
          message: "No sealed bottles available to open.",
        },
      },
    ],
  ] as const)("maps and stores the atomic %s outcome", async (outcome, status, body) => {
    const supabase = resultClient({
      outcome,
      response_status: status,
      response_body: body,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
  });

  it("fails a keyed RPC error closed without calling generic transitions", async () => {
    const providerError = {
      code: "XX000",
      message: "induced completion failure",
    };
    const supabase = makeSupabase(async (name) => {
      if (name !== "open_bottle_from_inventory_idempotent") {
        throw new Error(`unexpected rpc ${name}`);
      }
      return { data: null, error: providerError };
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(providerError, {
      tags: { surface: "open-bottles", phase: "idempotent-rpc" },
    });
  });

  it("redacts an unkeyed RPC error through the API boundary", async () => {
    const providerError = {
      code: "XX000",
      message: "super-secret provider failure",
    };
    const supabase = makeSupabase(async (name) => {
      if (name !== "open_bottle_from_inventory_idempotent") {
        throw new Error(`unexpected rpc ${name}`);
      }
      return { data: null, error: providerError };
    });
    allow(supabase);

    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails a malformed keyed RPC result closed so the same key can replay", async () => {
    const supabase = resultClient({
      outcome: "opened",
      response_status: 201,
      response_body: null,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: {
          surface: "open-bottles",
          phase: "idempotent-rpc-result",
        },
      },
    );
  });
});
