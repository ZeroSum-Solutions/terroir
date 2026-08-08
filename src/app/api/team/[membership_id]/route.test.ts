import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({ requireCapability: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireCapability(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { DELETE } = await import("./route");

const MEMBERSHIP_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "team_root_delete_0001";

function request(key?: string) {
  return new NextRequest(
    `http://localhost/api/team/${MEMBERSHIP_ID}`,
    {
      method: "DELETE",
      headers: key ? { "Idempotency-Key": key } : undefined,
    },
  );
}

function database(
  options: { claim?: unknown; removal?: unknown; removalError?: unknown } = {},
) {
  const rpc = vi.fn((name: string, args: unknown) => {
    if (name === "claim_api_idempotency") {
      return Promise.resolve({
        data: options.claim ?? [{ outcome: "claimed" }],
        error: null,
      });
    }
    if (name === "remove_team_member_idempotent") {
      return Promise.resolve({
        data:
          options.removal ??
          [
            {
              outcome: "removed",
              response_status: 200,
              response_body: { success: true },
              replayed: false,
              execution_started_at: "2026-08-07T00:00:00.000Z",
            },
          ],
        error: options.removalError ?? null,
      });
    }
    if (name === "complete_api_idempotency") {
      return Promise.resolve({ data: true, error: null });
    }
    throw new Error(`Unexpected RPC ${name}: ${JSON.stringify(args)}`);
  });
  return { client: { rpc }, rpc };
}

function authorize(client: unknown) {
  auth.requireCapability.mockResolvedValue({
    supabase: client,
    restaurantId: RESTAURANT_ID,
    user: { id: "33333333-3333-4333-8333-333333333333" },
    role: "owner",
  });
}

describe("DELETE /api/team/[membership_id] compatibility handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the exact authorization denial before resolving params", async () => {
    const denial = NextResponse.json(
      { error: { code: "forbidden", message: "Forbidden" } },
      { status: 403 },
    );
    auth.requireCapability.mockResolvedValue(denial);
    let paramTouches = 0;
    const params = {
      then(resolve: (value: { membership_id: string }) => void) {
        paramTouches += 1;
        resolve({ membership_id: MEMBERSHIP_ID });
      },
    } as unknown as Promise<{ membership_id: string }>;

    const response = await DELETE(request(), { params });

    expect(response).toBe(denial);
    expect(paramTouches).toBe(0);
  });

  it("rejects a malformed membership ID before database work", async () => {
    const db = database();
    authorize(db.client);

    const response = await DELETE(request(), {
      params: Promise.resolve({ membership_id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("removes a tenant membership and binds keyed retries to the exact path", async () => {
    const db = database();
    authorize(db.client);

    const response = await DELETE(request(KEY), {
      params: Promise.resolve({
        membership_id: MEMBERSHIP_ID.toUpperCase(),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(db.rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: RESTAURANT_ID,
      p_operation_id: "api:DELETE:/api/team/{param}",
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash({
        membershipId: MEMBERSHIP_ID,
      }),
    });
    expect(db.rpc).toHaveBeenNthCalledWith(
      2,
      "remove_team_member_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_member_id: MEMBERSHIP_ID,
      },
    );
  });

  it("does not expose a foreign or missing membership", async () => {
    const db = database({
      removal: [
        {
          outcome: "not_found",
          response_status: 404,
          response_body: {
            error: { code: "not_found", message: "Membership not found." },
          },
          replayed: false,
          execution_started_at: "2026-08-07T00:00:00.000Z",
        },
      ],
    });
    authorize(db.client);

    const response = await DELETE(request(), {
      params: Promise.resolve({ membership_id: MEMBERSHIP_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Membership not found." },
    });
  });

  it("redacts removal provider failures", async () => {
    const db = database({
      removalError: { code: "XX000", message: "private provider detail" },
    });
    authorize(db.client);

    const response = await DELETE(request(), {
      params: Promise.resolve({ membership_id: MEMBERSHIP_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("replays a keyed removal without calling the removal RPC", async () => {
    const db = database({
      claim: [
        {
          outcome: "replay",
          response_status: 200,
          response_headers: {},
          response_body: { success: true },
        },
      ],
    });
    authorize(db.client);

    const response = await DELETE(request(KEY), {
      params: Promise.resolve({ membership_id: MEMBERSHIP_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(db.rpc).not.toHaveBeenCalledWith(
      "remove_team_member_idempotent",
      expect.anything(),
    );
  });
});
