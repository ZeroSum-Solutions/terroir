import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({ requireCapability: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireCapability(...args),
}));

const { POST } = await import("./route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "team_root_invite_0001";

function request(body: unknown, key?: string) {
  return new NextRequest("http://localhost:3000/api/team", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

function database(
  insertError: unknown = null,
  claim: unknown = [{ outcome: "claimed" }],
) {
  const inserts: unknown[] = [];
  const insertQuery = {
    insert: vi.fn((payload: unknown) => {
      inserts.push(payload);
      return insertQuery;
    }),
    select: vi.fn(() => insertQuery),
    single: vi.fn(async () => ({
      data: insertError
        ? null
        : {
            id: "33333333-3333-4333-8333-333333333333",
            token: "invite-token",
            role: "manager",
            email: "alice@example.com",
            expires_at: "2026-08-14T00:00:00.000Z",
            created_at: "2026-08-07T00:00:00.000Z",
          },
      error: insertError,
    })),
  };
  const from = vi.fn(() => insertQuery);
  const rpc = vi.fn((name: string) => {
    if (name === "claim_api_idempotency") {
      return Promise.resolve({ data: claim, error: null });
    }
    if (name === "complete_api_idempotency") {
      return Promise.resolve({ data: true, error: null });
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { client: { from, rpc }, from, rpc, inserts };
}

function authorize(client: unknown) {
  auth.requireCapability.mockResolvedValue({
    supabase: client,
    restaurantId: RESTAURANT_ID,
    user: { id: USER_ID },
    role: "manager",
  });
}

describe("POST /api/team compatibility handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the exact authorization denial before parsing the body", async () => {
    const denial = NextResponse.json(
      { error: { code: "forbidden", message: "Forbidden" } },
      { status: 403 },
    );
    auth.requireCapability.mockResolvedValue(denial);

    const response = await POST(request({ email: "alice@example.com" }));

    expect(response).toBe(denial);
  });

  it("rejects an invalid invitation before database work", async () => {
    const db = database();
    authorize(db.client);

    const response = await POST(request({ email: "not-an-email" }));

    expect(response.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("creates a tenant invitation and binds keyed retries to the exact path", async () => {
    const db = database();
    authorize(db.client);
    const normalizedBody = { email: "alice@example.com", role: "manager" };

    const response = await POST(
      request({ email: " Alice@Example.com ", role: "manager" }, KEY),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: "alice@example.com",
      role: "manager",
      inviteUrl: "http://localhost:3000/invite/invite-token",
    });
    expect(db.inserts).toEqual([
      {
        restaurant_id: RESTAURANT_ID,
        email: "alice@example.com",
        role: "manager",
        invited_by: USER_ID,
      },
    ]);
    expect(db.rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: RESTAURANT_ID,
      p_operation_id: "api:POST:/api/team",
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash(normalizedBody),
    });
  });

  it("redacts invitation provider failures", async () => {
    const db = database({ message: "private provider detail" });
    authorize(db.client);

    const response = await POST(request({ email: "alice@example.com" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("replays a keyed invitation without inserting another row", async () => {
    const db = database(null, [
      {
        outcome: "replay",
        response_status: 200,
        response_headers: {},
        response_body: {
          id: "33333333-3333-4333-8333-333333333333",
          email: "alice@example.com",
          role: "manager",
          inviteUrl: "http://localhost:3000/invite/invite-token",
        },
      },
    ]);
    authorize(db.client);

    const response = await POST(
      request({ email: "alice@example.com", role: "manager" }, KEY),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(db.inserts).toEqual([]);
  });
});
