import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireMembership = vi.fn();
const mockRevalidatePath = vi.fn();
const mockCaptureException = vi.fn();
const mockRevalidateAutoEightysixedWines = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock("@/lib/api/auto-eightysix-revalidation", () => ({
  revalidateAutoEightysixedWines: (...args: unknown[]) =>
    mockRevalidateAutoEightysixedWines(...args),
}));

const { POST } = await import("./route");

const BOTTLE_ID = "22222222-2222-4222-8222-222222222222";
const WINE_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "33333333-3333-4333-8333-333333333333";
const RESTAURANT_ID = "44444444-4444-4444-8444-444444444444";
const INPUT_OPENED_AT = "2026-07-24T02:03:04-07:00";
const NORMALIZED_OPENED_AT = "2026-07-24T09:03:04.000000Z";
const CLOSED_AT = "2026-07-24T09:10:00.000Z";
const CLOSED_BODY = {
  closed: {
    id: BOTTLE_ID,
    wine_id: WINE_ID,
    closed_at: CLOSED_AT,
  },
};

function request(options: {
  key?: string;
  body?: unknown;
} = {}): NextRequest {
  return new Request(
    `http://localhost/api/open-bottles/${BOTTLE_ID}/close`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      body: JSON.stringify(
        options.body ?? { expected_opened_at: INPUT_OPENED_AT },
      ),
    },
  ) as unknown as NextRequest;
}

function context(id = BOTTLE_ID) {
  return { params: Promise.resolve({ id }) };
}

function makeSupabase(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>,
) {
  return { rpc: vi.fn(implementation) };
}

function resultClient(row: unknown) {
  return makeSupabase(async (name) => {
    if (name !== "close_open_bottle_idempotent") {
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

describe("POST /api/open-bottles/[id]/close", () => {
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

    const response = await POST(
      request({ body: { unexpected: "body is never parsed" } }),
      context("not-a-uuid"),
    );

    expect(response.status).toBe(401);
  });

  it("validates the bottle UUID before the body or RPC", async () => {
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { expected_opened_at: "not-a-datetime" },
    { expected_opened_at: "2026-07-24T09:03:04.1234567Z" },
    {
      expected_opened_at: INPUT_OPENED_AT,
      unexpected: true,
    },
  ])("strictly validates the expected generation body %#", async (body) => {
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ body }), context());

    expect(response.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects a malformed supplied key before the RPC", async () => {
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: "bad key" }), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("normalizes the generation and supports unkeyed compatibility", async () => {
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLOSED_BODY);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "close_open_bottle_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_bottle_id: BOTTLE_ID,
        p_expected_opened_at: NORMALIZED_OPENED_AT,
      },
    );
  });

  it("binds normalized bottle and generation identity to one keyed RPC", async () => {
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "close_open_bottle_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_bottle_id: BOTTLE_ID,
        p_expected_opened_at: NORMALIZED_OPENED_AT,
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          bottle_id: BOTTLE_ID,
          expected_opened_at: NORMALIZED_OPENED_AT,
        }),
      },
    );
    expect(mockRevalidatePath.mock.calls).toEqual([
      ["/cellar/open"],
      ["/cellar"],
      ["/availability"],
    ]);
    expect(mockRevalidateAutoEightysixedWines).toHaveBeenCalledWith({
      supabase,
      restaurantId: RESTAURANT_ID,
      touchedWineIds: [WINE_ID],
      sinceTs: expect.any(String),
    });
  });

  it("replays an exact committed success with one refresh sequence", async () => {
    const supabase = resultClient({
      outcome: "replay",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: true,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLOSED_BODY);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(3);
    expect(mockRevalidateAutoEightysixedWines).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "not_found",
      404,
      "Bottle not found.",
    ],
    [
      "stale_open_bottle",
      409,
      "This bottle was reopened after the page loaded. Refresh and try again.",
    ],
    [
      "already_closed",
      409,
      "Bottle is already closed.",
    ],
  ] as const)(
    "maps and stores the deterministic %s result",
    async (outcome, status, message) => {
      const body = { error: { code: outcome, message } };
      const supabase = resultClient({
        outcome,
        response_status: status,
        response_body: body,
        replayed: false,
      });
      allow(supabase);

      const response = await POST(request({ key: KEY }), context());

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("Idempotency-Replayed")).toBe("false");
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    },
  );

  it("replays a stored deterministic conflict exactly", async () => {
    const body = {
      error: {
        code: "stale_open_bottle",
        message:
          "This bottle was reopened after the page loaded. Refresh and try again.",
      },
    };
    const supabase = resultClient({
      outcome: "replay",
      response_status: 409,
      response_body: body,
      replayed: true,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("returns the exact in-progress envelope and retry hint", async () => {
    const body = {
      error: {
        code: "idempotency_in_progress",
        message:
          "A request with this Idempotency-Key is still in progress.",
      },
    };
    const supabase = resultClient({
      outcome: "idempotency_in_progress",
      response_status: 409,
      response_body: body,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

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
  ] as const)(
    "passes through %s without replay metadata",
    async (outcome, message) => {
      const body = { error: { code: outcome, message } };
      const supabase = resultClient({
        outcome,
        response_status: 409,
        response_body: body,
        replayed: false,
      });
      allow(supabase);

      const response = await POST(request({ key: KEY }), context());

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("Idempotency-Replayed")).toBeNull();
      expect(response.headers.get("Retry-After")).toBeNull();
    },
  );

  it("fails a keyed provider error closed", async () => {
    const providerError = {
      code: "XX000",
      message: "induced completion failure",
    };
    const supabase = makeSupabase(async () => ({
      data: null,
      error: providerError,
    }));
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(providerError, {
      tags: {
        surface: "open-bottles-close",
        phase: "idempotent-rpc",
      },
    });
  });

  it("redacts an unkeyed provider error at the API boundary", async () => {
    const supabase = makeSupabase(async () => ({
      data: null,
      error: {
        code: "XX000",
        message: "super-secret provider failure",
      },
    }));
    allow(supabase);

    const response = await POST(request(), context());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
  });

  it.each([
    null,
    {
      outcome: "closed",
      response_status: 200,
      response_body: null,
      replayed: false,
    },
    {
      outcome: "closed",
      response_status: 200,
      response_body: {
        closed: { ...CLOSED_BODY.closed, id: WINE_ID },
      },
      replayed: false,
    },
    {
      outcome: "replay",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    },
    {
      outcome: "already_closed",
      response_status: 404,
      response_body: {
        error: {
          code: "already_closed",
          message: "Bottle is already closed.",
        },
      },
      replayed: false,
    },
  ])("fails malformed keyed result %# closed for safe replay", async (row) => {
    const supabase = resultClient(row);
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
  });

  it("never lets a revalidation failure replace the committed response", async () => {
    const refreshError = new Error("cache unavailable");
    mockRevalidatePath.mockImplementation((path: string) => {
      if (path === "/cellar/open") throw refreshError;
    });
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLOSED_BODY);
    expect(mockRevalidatePath.mock.calls).toEqual([
      ["/cellar/open"],
      ["/cellar"],
      ["/availability"],
    ]);
    expect(mockCaptureException).toHaveBeenCalledWith(refreshError, {
      tags: {
        surface: "open-bottles-close",
        phase: "revalidate:/cellar/open",
      },
    });
  });

  it("never lets auto-86 revalidation replace the committed response", async () => {
    const refreshError = new Error("menu cache unavailable");
    mockRevalidateAutoEightysixedWines.mockRejectedValueOnce(refreshError);
    const supabase = resultClient({
      outcome: "closed",
      response_status: 200,
      response_body: CLOSED_BODY,
      replayed: false,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLOSED_BODY);
    expect(mockCaptureException).toHaveBeenCalledWith(refreshError, {
      tags: {
        surface: "open-bottles-close",
        phase: "revalidate:auto-eightysix",
      },
    });
  });
});
