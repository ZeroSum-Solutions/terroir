import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";

const mockRequireAuth = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { POST } = await import("./route");

const TOKEN = "a".repeat(48);
const KEY = "11111111-1111-4111-8111-111111111111";

function request(options: {
  key?: string;
  token?: string;
  ip?: string;
} = {}): NextRequest {
  return new Request("http://localhost/api/team/accept-invite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": options.ip ?? "1.2.3.4",
      ...(options.key ? { "Idempotency-Key": options.key } : {}),
    },
    body: JSON.stringify({ token: options.token ?? TOKEN }),
  }) as unknown as NextRequest;
}

function result(
  outcome:
    | "accepted"
    | "replay"
    | "not_found"
    | "already_used"
    | "invitation_expired"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress",
  status: number,
  body: unknown,
) {
  return {
    outcome,
    response_status: status,
    response_body: body,
    replayed: outcome === "replay",
  };
}

function accepted(outcome: "accepted" | "replay" = "accepted") {
  return result(outcome, 200, {
    success: true,
    role: "staff",
    restaurantId: "restaurant-a",
  });
}

function allow(
  rpcImplementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }> = async () => ({
    data: [result("not_found", 404, {
      error: {
        code: "not_found",
        message: "Invalid or expired invitation.",
      },
    })],
    error: null,
  }),
  user = { id: "user-a", email: "alice@example.com" },
) {
  const rpc = vi.fn(rpcImplementation);
  mockRequireAuth.mockResolvedValue({ supabase: { rpc }, user });
  return rpc;
}

describe("POST /api/team/accept-invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("preserves unauthenticated 401 precedence", async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      ),
    );

    for (let index = 0; index < 12; index += 1) {
      expect((await POST(request())).status).toBe(401);
    }
  });

  it("keeps the secondary user/IP ceiling", async () => {
    allow();

    for (let index = 0; index < 10; index += 1) {
      expect((await POST(request())).status).not.toBe(429);
    }
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("keeps secondary buckets separate by user", async () => {
    let userId = "user-a";
    const rpc = vi.fn(async () => ({
      data: [result("not_found", 404, {
        error: { code: "not_found", message: "Invalid or expired invitation." },
      })],
      error: null,
    }));
    mockRequireAuth.mockImplementation(async () => ({
      supabase: { rpc },
      user: { id: userId, email: `${userId}@example.com` },
    }));

    for (let index = 0; index < 10; index += 1) await POST(request());
    expect((await POST(request())).status).toBe(429);
    userId = "user-b";
    expect((await POST(request())).status).not.toBe(429);
  });

  it("rejects malformed supplied keys before the atomic RPC", async () => {
    const rpc = allow();
    const response = await POST(request({ key: "bad key" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("atomically accepts with an exact key/hash and fresh header", async () => {
    const rpc = allow(async () => ({
      data: [accepted()],
      error: null,
    }));

    const response = await POST(request({ key: KEY }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({
      success: true,
      role: "staff",
      restaurantId: "restaurant-a",
    });
    expect(rpc).toHaveBeenCalledWith(
      "accept_invitation_idempotent",
      expect.objectContaining({
        p_token: TOKEN,
        p_idempotency_key: KEY,
        p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("preserves missing-key compatibility without replay headers", async () => {
    const rpc = allow(async () => ({
      data: [accepted()],
      error: null,
    }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(rpc).toHaveBeenCalledWith("accept_invitation_idempotent", {
      p_token: TOKEN,
    });
  });

  it("returns exact replay and in-progress headers", async () => {
    const replayRpc = allow(async () => ({
      data: [accepted("replay")],
      error: null,
    }));
    const replay = await POST(request({ key: KEY }));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replayRpc).toHaveBeenCalledOnce();

    __resetRateLimitForTests();
    allow(async () => ({
      data: [
        result("idempotency_in_progress", 409, {
          error: {
            code: "idempotency_in_progress",
            message:
              "A request with this Idempotency-Key is still in progress.",
          },
        }),
      ],
      error: null,
    }));
    const inProgress = await POST(request({ key: KEY }));
    expect(inProgress.status).toBe(409);
    expect(inProgress.headers.get("Retry-After")).toBe("1");
  });

  it.each([
    [
      "not_found",
      404,
      "not_found",
      "Invalid or expired invitation.",
    ],
    [
      "invitation_expired",
      400,
      "bad_request",
      "This invitation has expired.",
    ],
    [
      "already_used",
      400,
      "bad_request",
      "This invitation has already been used.",
    ],
    [
      "idempotency_key_reused",
      409,
      "idempotency_key_reused",
      "This Idempotency-Key was already used for a different request.",
    ],
  ] as const)(
    "preserves the %s compatibility response",
    async (outcome, status, code, message) => {
      allow(async () => ({
        data: [result(outcome, status, { error: { code, message } })],
        error: null,
      }));

      const response = await POST(request({ key: KEY }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message } });
    },
  );

  it("fails closed with 503 when keyed RPC state is unavailable", async () => {
    const providerError = {
      code: "08006",
      message: "super-secret provider failure",
    };
    allow(async () => ({ data: null, error: providerError }));

    const response = await POST(request({ key: KEY }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
    expect(text).not.toContain("super-secret");
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("preserves redacted 500 behavior for an unkeyed RPC failure", async () => {
    allow(async () => ({
      data: null,
      error: { code: "XX000", message: "super-secret provider failure" },
    }));

    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
  });
});
