import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({
  requireOwner: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({
  requireOwner: (...args: unknown[]) => auth.requireOwner(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { PATCH, DELETE } = await import("./route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "team_member_key_0063";
const STARTED_AT = "2026-07-24T20:00:00.000Z";

type Result = {
  outcome: string;
  response_status: number;
  response_body: unknown;
  replayed: boolean;
  execution_started_at: string;
};

function request(
  method: "PATCH" | "DELETE",
  options: { body?: unknown; key?: string } = {},
) {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.key !== undefined) {
    headers.set("Idempotency-Key", options.key);
  }
  return new NextRequest(
    `http://localhost/api/team/members/${MEMBER_ID}`,
    {
      method,
      headers,
      body:
        options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
    },
  );
}

function result(
  outcome: string,
  status: number,
  body: unknown,
  replayed = false,
): Result {
  return {
    outcome,
    response_status: status,
    response_body: body,
    replayed,
    execution_started_at: STARTED_AT,
  };
}

function ownerWithRpc(
  rpc: ReturnType<typeof vi.fn>,
): void {
  auth.requireOwner.mockResolvedValue({
    supabase: { rpc },
    restaurantId: RESTAURANT_ID,
    user: { id: "33333333-3333-4333-8333-333333333333" },
    role: "owner",
  });
}

async function patch(
  body: unknown = { role: "manager" },
  key?: string,
) {
  return PATCH(request("PATCH", { body, key }), {
    params: Promise.resolve({ id: MEMBER_ID }),
  });
}

async function remove(key?: string) {
  return DELETE(request("DELETE", { key }), {
    params: Promise.resolve({ id: MEMBER_ID }),
  });
}

describe("team member idempotent routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the exact owner denial before parsing or calling the RPC", async () => {
    const denial = NextResponse.json(
      { error: { code: "forbidden", message: "Owner access required." } },
      { status: 403 },
    );
    auth.requireOwner.mockResolvedValue(denial);

    const patchResponse = await PATCH(
      request("PATCH", { body: { role: "manager" } }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(patchResponse).toBe(denial);
  });

  it("passes the canonical validated path and body hash to the update RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: [result("updated", 200, { success: true })],
      error: null,
    }));
    ownerWithRpc(rpc);

    const response = await patch({ role: "manager" }, KEY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(rpc).toHaveBeenCalledWith(
      "update_team_member_role_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_member_id: MEMBER_ID,
        p_role: "manager",
        p_idempotency_key: KEY,
        p_request_hash: createIdempotencyRequestHash({
          id: MEMBER_ID,
          role: "manager",
        }),
      },
    );
  });

  it("passes the canonical validated path hash to the removal RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: [result("removed", 200, { success: true })],
      error: null,
    }));
    ownerWithRpc(rpc);

    const response = await remove(KEY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledWith("remove_team_member_idempotent", {
      p_restaurant_id: RESTAURANT_ID,
      p_member_id: MEMBER_ID,
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash({ id: MEMBER_ID }),
    });
  });

  it("preserves keyless compatibility without synthetic keyed arguments", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        result("last_owner", 400, {
          error: {
            code: "bad_request",
            message: "Cannot demote the last owner.",
          },
        }),
      ],
      error: null,
    }));
    ownerWithRpc(rpc);

    const response = await patch({ role: "staff" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message: "Cannot demote the last owner.",
      },
    });
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    const [, args] = rpc.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(args).not.toHaveProperty("p_idempotency_key");
  });

  it("returns exact not-found and self-removal envelopes", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          result("not_found", 404, {
            error: { code: "not_found", message: "Member not found." },
          }),
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          result("self_removal", 400, {
            error: {
              code: "bad_request",
              message: "Cannot remove yourself.",
            },
          }),
        ],
        error: null,
      });
    ownerWithRpc(rpc);

    const missing = await remove();
    const self = await remove();

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "not_found", message: "Member not found." },
    });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({
      error: {
        code: "bad_request",
        message: "Cannot remove yourself.",
      },
    });
  });

  it("marks exact replays and in-progress responses", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [result("replay", 200, { success: true }, true)],
        error: null,
      })
      .mockResolvedValueOnce({
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
      });
    ownerWithRpc(rpc);

    const replay = await patch({ role: "manager" }, KEY);
    const inProgress = await remove(KEY);

    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(inProgress.status).toBe(409);
    expect(inProgress.headers.get("Retry-After")).toBe("1");
  });

  it("rejects invalid keys and bodies before the RPC", async () => {
    const rpc = vi.fn();
    ownerWithRpc(rpc);

    const invalidKey = await patch({ role: "manager" }, "short");
    const invalidBody = await patch({ role: "admin" }, KEY);

    expect(invalidKey.status).toBe(400);
    expect(await invalidKey.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps authorization and keyed canonical-argument failures exactly", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "42501", message: "secret detail" },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "22023", message: "secret detail" },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "22023", message: "secret detail" },
      });
    ownerWithRpc(rpc);

    const forbidden = await patch({ role: "manager" }, KEY);
    const keyedInvalid = await patch({ role: "manager" }, KEY);
    const keylessInvalid = await patch();

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "forbidden", message: "Forbidden." },
    });
    expect(keyedInvalid.status).toBe(400);
    expect(await keyedInvalid.json()).toEqual({
      error: {
        code: "invalid_team_member_role_request",
        message: "Invalid team member role request.",
      },
    });
    expect(keylessInvalid.status).toBe(500);
    expect(await keylessInvalid.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });

  it("fails closed on provider errors and malformed keyed results", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "XX000", message: "provider secret" },
      })
      .mockResolvedValueOnce({
        data: [
          result("removed", 200, {
            success: true,
            extra: "untrusted",
          }),
        ],
        error: null,
      });
    ownerWithRpc(rpc);

    const providerFailure = await remove(KEY);
    const malformed = await remove(KEY);

    expect(providerFailure.status).toBe(503);
    expect(await providerFailure.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
  });
});
