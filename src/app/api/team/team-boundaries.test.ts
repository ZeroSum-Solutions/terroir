import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireMembership: vi.fn(),
  requireOwner: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({
  requireAuth: (...args: unknown[]) => auth.requireAuth(...args),
  requireCapability: (...args: unknown[]) => auth.requireOwner(...args),
  requireMembership: (...args: unknown[]) => auth.requireMembership(...args),
  requireOwner: (...args: unknown[]) => auth.requireOwner(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: ACCEPT } = await import("./accept-invite/route");
const { POST: INVITE } = await import("./invite/route");
const { DELETE: REVOKE } = await import("./invite/[id]/route");
const { POST: RESEND } = await import("./invite/[id]/resend/route");
const { GET: MEMBERS } = await import("./members/route");
const { PATCH: CHANGE_ROLE, DELETE: REMOVE } =
  await import("./members/[id]/route");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function watchedParams(id = VALID_ID) {
  let touches = 0;
  const params = {
    then(resolve: (value: { id: string }) => void) {
      touches += 1;
      resolve({ id });
    },
  } as unknown as Promise<{ id: string }>;
  return { params, touches: () => touches };
}

type QueryResult = { data: unknown; error: unknown };

function queryEndingIn(
  terminal: "maybeSingle" | "single" | "order",
  result: QueryResult,
) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of [
    "select",
    "eq",
    "is",
    "limit",
    "insert",
    "update",
    "delete",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query[terminal] = vi.fn(async () => result);
  return query;
}

describe("team API boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  const denial = () =>
    NextResponse.json(
      { error: { code: "unauthorized", message: "Unauthorized" } },
      { status: 401 },
    );

  const noParamOperations = [
    {
      name: "POST accept-invite",
      auth: "requireAuth" as const,
      call: () =>
        ACCEPT(
          request("/api/team/accept-invite", "POST", { token: "a".repeat(48) }),
        ),
    },
    {
      name: "POST invite",
      auth: "requireOwner" as const,
      call: () =>
        INVITE(request("/api/team/invite", "POST", { email: "a@example.com" })),
    },
    {
      name: "GET members",
      auth: "requireMembership" as const,
      call: () => MEMBERS(),
    },
  ];

  for (const operation of noParamOperations) {
    it(`${operation.name} returns the exact auth denial before dependencies`, async () => {
      const responseIdentity = denial();
      auth[operation.auth].mockResolvedValue(responseIdentity);

      const response = await operation.call();

      expect(response).toBe(responseIdentity);
    });
  }

  const paramOperations = [
    {
      name: "DELETE invite",
      call: (params: Promise<{ id: string }>) =>
        REVOKE(request(`/api/team/invite/${VALID_ID}`, "DELETE"), {
          params,
        }),
    },
    {
      name: "POST resend invite",
      call: (params: Promise<{ id: string }>) =>
        RESEND(request(`/api/team/invite/${VALID_ID}/resend`, "POST"), {
          params,
        }),
    },
    {
      name: "PATCH member",
      call: (params: Promise<{ id: string }>) =>
        CHANGE_ROLE(
          request(`/api/team/members/${VALID_ID}`, "PATCH", { role: "staff" }),
          { params },
        ),
    },
    {
      name: "DELETE member",
      call: (params: Promise<{ id: string }>) =>
        REMOVE({} as NextRequest, { params }),
    },
  ];

  for (const operation of paramOperations) {
    it(`${operation.name} returns the exact owner denial before resolving params`, async () => {
      const responseIdentity = denial();
      auth.requireOwner.mockResolvedValue(responseIdentity);
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(responseIdentity);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid UUID before dependencies`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      auth.requireOwner.mockResolvedValue({
        supabase: { from },
        restaurantId: "22222222-2222-4222-8222-222222222222",
        user: { id: "33333333-3333-4333-8333-333333333333" },
        role: "owner",
      });

      const response = await operation.call(
        Promise.resolve({ id: "not-a-uuid" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(from).not.toHaveBeenCalled();
    });
  }
});

describe("team API provider and mutation boundaries", () => {
  const restaurantId = "22222222-2222-4222-8222-222222222222";
  const user = {
    id: "33333333-3333-4333-8333-333333333333",
    email: "owner@example.com",
  };

  beforeEach(() => vi.clearAllMocks());

  function ownerAuth(from: ReturnType<typeof vi.fn>) {
    auth.requireOwner.mockResolvedValue({
      supabase: { from },
      restaurantId,
      user,
      role: "owner",
    });
  }

  it("redacts an invitation lookup provider failure instead of masking it as missing", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: null,
      error: new Error("provider secret"),
    });
    ownerAuth(vi.fn(() => lookup));

    const response = await REVOKE(
      request(`/api/team/invite/${VALID_ID}`, "DELETE"),
      {
      params: Promise.resolve({ id: VALID_ID }),
      },
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
    expect(JSON.stringify(body)).not.toContain("provider secret");
  });

  it("requires the tenant-scoped invitation delete to affect a row", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: { id: VALID_ID, accepted_at: null },
      error: null,
    });
    const deletion = queryEndingIn("maybeSingle", {
      data: null,
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(deletion);
    ownerAuth(from);

    const response = await REVOKE(
      request(`/api/team/invite/${VALID_ID}`, "DELETE"),
      {
      params: Promise.resolve({ id: VALID_ID }),
      },
    );

    expect(response.status).toBe(404);
    expect(deletion.eq).toHaveBeenCalledWith("id", VALID_ID);
    expect(deletion.eq).toHaveBeenCalledWith("restaurant_id", restaurantId);
    expect(deletion.select).toHaveBeenCalledWith("id");
  });

  it("resends with the trusted request URL origin and tenant-scoped lookup", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: {
        id: VALID_ID,
        email: "invitee@example.com",
        role: "manager",
        accepted_at: null,
      },
      error: null,
    });
    const insertion = queryEndingIn("single", {
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        token: "b".repeat(48),
        email: "invitee@example.com",
        role: "manager",
        expires_at: "2026-08-01T00:00:00.000Z",
        created_at: "2026-07-23T00:00:00.000Z",
      },
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(insertion);
    ownerAuth(from);

    const response = await RESEND(
      new NextRequest(
        `http://localhost:3000/api/team/invite/${VALID_ID}/resend`,
        {
          method: "POST",
          headers: { origin: "https://evil.example" },
        },
      ),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).inviteUrl).toBe(
      `http://localhost:3000/invite/${"b".repeat(48)}`,
    );
    expect(lookup.eq).toHaveBeenCalledWith("restaurant_id", restaurantId);
    expect(insertion.insert).toHaveBeenCalledWith({
      restaurant_id: restaurantId,
      email: "invitee@example.com",
      role: "manager",
      invited_by: user.id,
    });
  });

  it("binds a member role update to the selected tenant and validated input", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        outcome: "not_found",
        response_status: 404,
        response_body: {
          error: { code: "not_found", message: "Member not found." },
        },
        replayed: false,
        execution_started_at: "2026-07-24T20:00:00.000Z",
      }],
      error: null,
    }));
    auth.requireOwner.mockResolvedValue({
      supabase: { rpc },
      restaurantId,
      user,
      role: "owner",
    });

    const response = await CHANGE_ROLE(
      request(`/api/team/members/${VALID_ID}`, "PATCH", { role: "manager" }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(404);
    expect(rpc).toHaveBeenCalledWith(
      "update_team_member_role_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_member_id: VALID_ID,
        p_role: "manager",
      },
    );
  });

  it("binds a member removal to the selected tenant and validated path", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        outcome: "not_found",
        response_status: 404,
        response_body: {
          error: { code: "not_found", message: "Member not found." },
        },
        replayed: false,
        execution_started_at: "2026-07-24T20:00:00.000Z",
      }],
      error: null,
    }));
    auth.requireOwner.mockResolvedValue({
      supabase: { rpc },
      restaurantId,
      user,
      role: "owner",
    });

    const response = await REMOVE(
      request(`/api/team/members/${VALID_ID}`, "DELETE"),
      {
      params: Promise.resolve({ id: VALID_ID }),
      },
    );

    expect(response.status).toBe(404);
    expect(rpc).toHaveBeenCalledWith("remove_team_member_idempotent", {
      p_restaurant_id: restaurantId,
      p_member_id: VALID_ID,
    });
  });

  it("rejects extra member role fields before any database query", async () => {
    const from = vi.fn();
    ownerAuth(from);

    const response = await CHANGE_ROLE(
      request(`/api/team/members/${VALID_ID}`, "PATCH", {
        role: "staff",
        restaurant_id: "attacker-controlled",
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
