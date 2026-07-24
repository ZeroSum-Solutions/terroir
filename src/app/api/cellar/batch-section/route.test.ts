import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { POST } = await import("./route");

const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const WINE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WINE_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "batch-section-key-0001";

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
  return new Request("http://localhost/api/cellar/batch-section", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as NextRequest;
}

function makeSupabase(options: {
  claimRow?: ClaimRow;
  businessError?: { message: string } | null;
} = {}) {
  const claimRow = options.claimRow ?? {
    outcome: "claimed",
    response_status: null,
    response_body: null,
    response_headers: null,
  };
  const rpc = vi.fn(
    async (operation: string) => {
      if (operation === "claim_api_idempotency") {
        return { data: [claimRow], error: null };
      }
      if (operation === "assign_cellar_section_batch") {
        return {
          data: null,
          error: options.businessError ?? null,
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
    },
  );
  return { rpc };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    role: "manager",
    user: { id: "user-a" },
  });
}

describe("POST /api/cellar/batch-section idempotency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves exact keyless behavior with only the business RPC", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await POST(
      request({
        wine_ids: [WINE_ID, OTHER_WINE_ID],
        section: "Reserve",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toEqual({
      updated: 2,
      section: "Reserve",
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "assign_cellar_section_batch",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_ids: [WINE_ID, OTHER_WINE_ID],
        p_section: "Reserve",
      },
    );
  });

  it("rejects a malformed key before the business RPC or claim", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await POST(
      request(
        { wine_ids: [WINE_ID], section: "Reserve" },
        "bad key!",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("claims the canonical body, runs the atomic RPC, and completes", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await POST(
      request(
        {
          wine_ids: [WINE_ID, OTHER_WINE_ID],
          section: "  Reserve  ",
        },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({
      updated: 2,
      section: "Reserve",
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:POST:/api/cellar/batch-section",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          wine_ids: [WINE_ID, OTHER_WINE_ID],
          section: "Reserve",
        }),
      },
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      "assign_cellar_section_batch",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_ids: [WINE_ID, OTHER_WINE_ID],
        p_section: "Reserve",
      },
    );
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      3,
      "complete_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:POST:/api/cellar/batch-section",
        p_idempotency_key: KEY,
        p_response_status: 200,
        p_response_body: {
          updated: 2,
          section: "Reserve",
        },
      }),
    );
  });

  it("replays an exact completed response without the atomic RPC", async () => {
    const replayBody = { updated: 2, section: "Reserve" };
    const supabase = makeSupabase({
      claimRow: {
        outcome: "replay",
        response_status: 200,
        response_body: replayBody,
        response_headers: {},
      },
    });
    allow(supabase);

    const response = await POST(
      request(
        {
          wine_ids: [WINE_ID, OTHER_WINE_ID],
          section: "Reserve",
        },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "authentication",
      setup: () =>
        mockRequireRole.mockResolvedValue(
          NextResponse.json(
            { error: { code: "unauthorized", message: "Unauthorized." } },
            { status: 401 },
          ),
        ),
      body: { wine_ids: [WINE_ID], section: "Reserve" },
      status: 401,
    },
    {
      label: "validation",
      setup: (supabase: ReturnType<typeof makeSupabase>) =>
        allow(supabase),
      body: { wine_ids: [WINE_ID, WINE_ID], section: "Reserve" },
      status: 400,
    },
  ])("rejects $label before an idempotency claim", async ({
    setup,
    body,
    status,
  }) => {
    const supabase = makeSupabase();
    setup(supabase);

    const response = await POST(request(body, KEY));

    expect(response.status).toBe(status);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("completes a deterministic atomic 404 for exact replay", async () => {
    const supabase = makeSupabase({
      businessError: { message: "cellar_inventory_missing" },
    });
    allow(supabase);

    const response = await POST(
      request({ wine_ids: [WINE_ID], section: "Reserve" }, KEY),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Inventory item not found.",
      },
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      3,
      "complete_api_idempotency",
      expect.objectContaining({
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

  it("fails closed and marks unexpected provider failures", async () => {
    const supabase = makeSupabase({
      businessError: { message: "private provider detail" },
    });
    allow(supabase);

    const response = await POST(
      request({ wine_ids: [WINE_ID], section: "Reserve" }, KEY),
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      3,
      "fail_api_idempotency",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_operation_id: "api:POST:/api/cellar/batch-section",
        p_idempotency_key: KEY,
      }),
    );
  });
});
