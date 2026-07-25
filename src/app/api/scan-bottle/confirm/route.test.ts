import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const ITEM_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
const ADDED_AT = "2026-07-24T00:00:00.000Z";
const EXECUTION_STARTED_AT = "2026-07-24T00:00:00.000Z";

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

function confirmedResult(overrides: Record<string, unknown> = {}): RpcResult {
  return {
    data: [
      {
        outcome: "confirmed",
        response_status: 201,
        response_body: {
          id: ITEM_ID,
          section: "Reds",
          bin_location: "A-1",
          added_at: ADDED_AT,
          wine_id: WINE_ID,
        },
        replayed: false,
        execution_started_at: EXECUTION_STARTED_AT,
        ...overrides,
      },
    ],
    error: null,
  };
}

function makeSupabase(result: RpcResult = confirmedResult()) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

function request(
  body: unknown,
  idempotencyKey?: string,
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("http://localhost/api/scan-bottle/confirm", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const VALID_BODY = {
  wine_id: WINE_ID,
  section: " Reds ",
  bin_location: " A-1 ",
};

describe("POST /api/scan-bottle/confirm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects invalid input and malformed keys before the RPC", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const invalidBody = await POST(
      request({ wine_id: "nope", section: "", bin_location: "" }),
    );
    const invalidKey = await POST(request(VALID_BODY, "bad key"));

    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(invalidKey.status).toBe(400);
    expect(await invalidKey.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("preserves keyless status, body, normalized input, and tenant scope", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual({
      id: ITEM_ID,
      section: "Reds",
      bin_location: "A-1",
      added_at: ADDED_AT,
      wine_id: WINE_ID,
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "confirm_bottle_scan_idempotent",
      {
        p_restaurant_id: "restaurant-a",
        p_wine_id: WINE_ID,
        p_section: "Reds",
        p_bin_location: "A-1",
      },
    );
  });

  it("binds a keyed request to every normalized input field", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await POST(request(VALID_BODY, "confirm_key_0064"));

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "confirm_bottle_scan_idempotent",
      expect.objectContaining({
        p_idempotency_key: "confirm_key_0064",
        p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_restaurant_id: "restaurant-a",
        p_wine_id: WINE_ID,
        p_section: "Reds",
        p_bin_location: "A-1",
      }),
    );
  });

  it("canonicalizes an uppercase wine UUID before hashing and calling the RPC", async () => {
    const supabase = makeSupabase();
    allow(supabase);
    const uppercaseWineId = WINE_ID.toUpperCase();

    const response = await POST(
      request(
        { ...VALID_BODY, wine_id: uppercaseWineId },
        "confirm_uppercase_0064",
      ),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ wine_id: WINE_ID });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "confirm_bottle_scan_idempotent",
      expect.objectContaining({
        p_wine_id: WINE_ID,
        p_request_hash: createIdempotencyRequestHash({
          wine_id: WINE_ID,
          section: "Reds",
          bin_location: "A-1",
        }),
      }),
    );
  });

  it("returns the exact stored replay and replay marker", async () => {
    const replay = confirmedResult({
      outcome: "replay",
      replayed: true,
    });
    const supabase = makeSupabase(replay);
    allow(supabase);

    const response = await POST(request(VALID_BODY, "confirm_replay_0064"));

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(
      (replay.data as Array<{ response_body: unknown }>)[0].response_body,
    );
  });

  it("preserves the opaque tenant miss and in-progress retry metadata", async () => {
    const missing = makeSupabase({
      data: [
        {
          outcome: "wine_not_found",
          response_status: 404,
          response_body: {
            error: {
              code: "wine_not_found",
              message: "Wine not found or not in your restaurant.",
            },
          },
          replayed: false,
          execution_started_at: EXECUTION_STARTED_AT,
        },
      ],
      error: null,
    });
    allow(missing);
    const missingResponse = await POST(
      request(VALID_BODY, "confirm_missing_0064"),
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      error: {
        code: "wine_not_found",
        message: "Wine not found or not in your restaurant.",
      },
    });

    const inProgress = makeSupabase({
      data: [
        {
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
          execution_started_at: EXECUTION_STARTED_AT,
        },
      ],
      error: null,
    });
    allow(inProgress);
    const conflict = await POST(
      request(VALID_BODY, "confirm_progress_0064"),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("Retry-After")).toBe("1");
  });

  it("fails closed on keyed RPC errors and malformed results", async () => {
    const failed = makeSupabase({
      data: null,
      error: { code: "XX000", message: "secret failure" },
    });
    allow(failed);
    const failedResponse = await POST(
      request(VALID_BODY, "confirm_failure_0064"),
    );
    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });

    const malformed = makeSupabase(
      confirmedResult({
        response_body: {
          id: ITEM_ID,
          section: "Wrong",
          bin_location: "A-1",
          added_at: ADDED_AT,
          wine_id: WINE_ID,
        },
      }),
    );
    allow(malformed);
    const malformedResponse = await POST(
      request(VALID_BODY, "confirm_malformed_0064"),
    );
    expect(malformedResponse.status).toBe(503);
  });

  it("redacts a keyless RPC failure", async () => {
    const supabase = makeSupabase({
      data: null,
      error: { code: "XX000", message: "super-secret insert failure" },
    });
    allow(supabase);

    const response = await POST(request(VALID_BODY));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
  });
});
