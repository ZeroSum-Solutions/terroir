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

function openRow(outcome: "opened" | "not_found" | "no_sealed_stock") {
  return {
    outcome,
    bottle_id: outcome === "opened" ? BOTTLE_ID : null,
    wine_id: outcome === "opened" ? WINE_ID : null,
    remaining_ml: outcome === "opened" ? 750 : null,
    opened_at:
      outcome === "opened" ? "2026-07-24T00:00:00.000Z" : null,
  };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

function firstClaimClient(
  business: { data: unknown; error: unknown } = {
    data: [openRow("opened")],
    error: null,
  },
) {
  return makeSupabase(async (name) => {
    if (name === "claim_api_idempotency") {
      return {
        data: [
          {
            outcome: "claimed",
            response_status: null,
            response_headers: null,
            response_body: null,
          },
        ],
        error: null,
      };
    }
    if (name === "open_bottle_from_inventory") return business;
    if (
      name === "complete_api_idempotency" ||
      name === "fail_api_idempotency"
    ) {
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
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
    const supabase = firstClaimClient();
    allow(supabase);

    const response = await POST(request({ key: "bad key" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("keeps missing-key compatibility while using the atomic RPC", async () => {
    const supabase = firstClaimClient();
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "open_bottle_from_inventory",
      {
        p_restaurant_id: "restaurant-a",
        p_wine_id: WINE_ID,
      },
    );
  });

  it("claims, atomically opens, completes, and returns the compatibility envelope", async () => {
    const supabase = firstClaimClient();
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({
      open_bottle: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 750,
        opened_at: "2026-07-24T00:00:00.000Z",
      },
    });
    expect(
      supabase.rpc.mock.calls.filter(
        ([name]) => name === "open_bottle_from_inventory",
      ),
    ).toHaveLength(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cellar/open");
  });

  it("replays a completed result without invoking the business RPC", async () => {
    const supabase = makeSupabase(async (name) => {
      if (name !== "claim_api_idempotency") {
        throw new Error(`unexpected rpc ${name}`);
      }
      return {
        data: [
          {
            outcome: "replay",
            response_status: 201,
            response_headers: {},
            response_body: {
              open_bottle: {
                id: BOTTLE_ID,
                wine_id: WINE_ID,
                remaining_ml: 750,
                opened_at: "2026-07-24T00:00:00.000Z",
              },
            },
          },
        ],
        error: null,
      };
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("returns the exact in-progress envelope without invoking the business RPC", async () => {
    const supabase = makeSupabase(async (name) => {
      if (name !== "claim_api_idempotency") {
        throw new Error(`unexpected rpc ${name}`);
      }
      return {
        data: [
          {
            outcome: "in_progress",
            response_status: null,
            response_headers: null,
            response_body: null,
          },
        ],
        error: null,
      };
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
  ] as const)("maps the atomic %s outcome", async (outcome, status, body) => {
    const supabase = firstClaimClient({
      data: [openRow(outcome)],
      error: null,
    });
    allow(supabase);

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
  });

  it("redacts a business RPC failure and marks the keyed outcome unknown", async () => {
    const providerError = {
      code: "XX000",
      message: "super-secret provider failure",
    };
    const supabase = firstClaimClient({ data: null, error: providerError });
    allow(supabase);

    const response = await POST(request({ key: KEY }));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "fail_api_idempotency",
      expect.anything(),
    );
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "complete_api_idempotency",
      expect.anything(),
    );
  });
});
