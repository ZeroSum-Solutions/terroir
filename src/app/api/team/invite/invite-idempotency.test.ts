import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const mockRequireCapability = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    mockRequireCapability(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { POST: CREATE } = await import("./route");
const { DELETE: REVOKE } = await import("./[id]/route");
const { POST: RESEND } = await import("./[id]/resend/route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const NEW_INVITATION_ID = "44444444-4444-4444-8444-444444444444";
const KEY = "team-invitation-command-0001";
const CREATED_AT = "2026-07-24T17:00:00.000Z";
const EXPIRES_AT = "2026-07-31T17:00:00.000Z";

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

const claimed: ClaimRow = {
  outcome: "claimed",
  response_status: null,
  response_body: null,
  response_headers: null,
};

function makeRpc(
  claims: readonly ClaimRow[] = [claimed],
  options: { failFirstCompletion?: boolean } = {},
) {
  let claimIndex = 0;
  let completionCount = 0;
  return vi.fn(async (operation: string) => {
    if (operation === "claim_api_idempotency") {
      const row = claims[Math.min(claimIndex, claims.length - 1)];
      claimIndex += 1;
      return { data: [row], error: null };
    }
    if (operation === "complete_api_idempotency") {
      completionCount += 1;
      if (options.failFirstCompletion && completionCount === 1) {
        return {
          data: null,
          error: { code: "08006", message: "completion unavailable" },
        };
      }
      return { data: true, error: null };
    }
    if (
      operation === "fail_api_idempotency" ||
      operation === "release_api_idempotency"
    ) {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${operation}`);
  });
}

type QueryResult = { data: unknown; error: unknown };

function queryEndingIn(
  terminal: "single" | "maybeSingle",
  result: QueryResult,
) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "insert", "delete"]) {
    query[method] = vi.fn(() => query);
  }
  query[terminal] = vi.fn(async () => result);
  return query;
}

function allow(supabase: {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
}) {
  mockRequireCapability.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: USER_ID },
    role: "owner",
  });
}

function createRequest(
  body: unknown,
  key: string | null = null,
): NextRequest {
  return new NextRequest("http://localhost:3000/api/team/invite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

function pathRequest(
  method: "POST" | "DELETE",
  path: string,
  key: string | null = null,
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: key ? { "Idempotency-Key": key } : undefined,
  });
}

function inviteRow(
  id = NEW_INVITATION_ID,
  token = "a".repeat(48),
) {
  return {
    id,
    token,
    role: "manager",
    email: "invitee@example.com",
    expires_at: EXPIRES_AT,
    created_at: CREATED_AT,
  };
}

describe("team invite idempotency boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("claims the normalized create body, inserts once, and completes the exact response", async () => {
    const insertion = queryEndingIn("single", {
      data: inviteRow(),
      error: null,
    });
    const from = vi.fn(() => insertion);
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await CREATE(
      createRequest(
        { email: "  Invitee@Example.com ", role: "manager" },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({
      ...inviteRow(),
      inviteUrl: `http://localhost:3000/invite/${"a".repeat(48)}`,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: RESTAURANT_ID,
      p_operation_id: "api:POST:/api/team/invite",
      p_idempotency_key: KEY,
      p_request_hash: createIdempotencyRequestHash({
        email: "invitee@example.com",
        role: "manager",
      }),
    });
    expect(insertion.insert).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:POST:/api/team/invite",
        p_response_status: 200,
        p_response_body: {
          ...inviteRow(),
          inviteUrl: `http://localhost:3000/invite/${"a".repeat(48)}`,
        },
      }),
    );
  });

  it("rejects a malformed create key after normalized validation but before claim or insert", async () => {
    const insertion = queryEndingIn("single", {
      data: inviteRow(),
      error: null,
    });
    const from = vi.fn(() => insertion);
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await CREATE(
      createRequest({ email: "invitee@example.com" }, "bad key!"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects unrecognized create fields before an idempotency claim", async () => {
    const from = vi.fn();
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await CREATE(
      createRequest(
        {
          email: "invitee@example.com",
          role: "staff",
          restaurant_id: "attacker-controlled",
        },
        KEY,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("preserves the keyless create provider error without idempotency storage", async () => {
    const insertion = queryEndingIn("single", {
      data: null,
      error: { code: "08006", message: "provider unavailable" },
    });
    const from = vi.fn(() => insertion);
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await CREATE(
      createRequest({
        email: "invitee@example.com",
        role: "manager",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(insertion.insert).toHaveBeenCalledOnce();
  });

  it("replays a completed create without another invitation insert", async () => {
    const replayBody = {
      ...inviteRow(),
      inviteUrl: `http://localhost:3000/invite/${"a".repeat(48)}`,
    };
    const from = vi.fn();
    const rpc = makeRpc([
      {
        outcome: "replay",
        response_status: 200,
        response_body: replayBody,
        response_headers: {},
      },
    ]);
    allow({ from, rpc });

    const response = await CREATE(
      createRequest(
        { email: "invitee@example.com", role: "manager" },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(from).not.toHaveBeenCalled();
  });

  it("never repeats create business work after completion ambiguity", async () => {
    const insertion = queryEndingIn("single", {
      data: inviteRow(),
      error: null,
    });
    const from = vi.fn(() => insertion);
    const rpc = makeRpc(
      [
        claimed,
        {
          outcome: "outcome_unknown",
          response_status: null,
          response_body: null,
          response_headers: null,
        },
      ],
      { failFirstCompletion: true },
    );
    allow({ from, rpc });
    const body = { email: "invitee@example.com", role: "manager" };

    const first = await CREATE(createRequest(body, KEY));
    const retry = await CREATE(createRequest(body, KEY));

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      error: { code: "idempotency_outcome_unknown" },
    });
    expect(insertion.insert).toHaveBeenCalledOnce();
  });

  it("completes accepted revoke behavior exactly and never deletes", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: { id: INVITATION_ID, accepted_at: CREATED_AT },
      error: null,
    });
    const from = vi.fn(() => lookup);
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await REVOKE(
      pathRequest("DELETE", `/api/team/invite/${INVITATION_ID}`, KEY),
      { params: Promise.resolve({ id: INVITATION_ID }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message:
          "Invitation already accepted. Remove the member instead.",
      },
    });
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:DELETE:/api/team/invite/{param}",
        p_request_hash: createIdempotencyRequestHash({
          id: INVITATION_ID,
        }),
      }),
    );
    expect(lookup.delete).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_response_status: 400,
      }),
    );
  });

  it("preserves keyless revoke 404 without idempotency storage", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: null,
      error: null,
    });
    const from = vi.fn(() => lookup);
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await REVOKE(
      pathRequest("DELETE", `/api/team/invite/${INVITATION_ID}`),
      { params: Promise.resolve({ id: INVITATION_ID }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Invitation not found.",
      },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("deletes once and replays the completed keyed revoke", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: { id: INVITATION_ID, accepted_at: null },
      error: null,
    });
    const deletion = queryEndingIn("maybeSingle", {
      data: { id: INVITATION_ID },
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(deletion);
    const rpc = makeRpc([
      claimed,
      {
        outcome: "replay",
        response_status: 200,
        response_body: { success: true },
        response_headers: {},
      },
    ]);
    allow({ from, rpc });
    const path = `/api/team/invite/${INVITATION_ID}`;

    const first = await REVOKE(pathRequest("DELETE", path, KEY), {
      params: Promise.resolve({ id: INVITATION_ID }),
    });
    const retry = await REVOKE(pathRequest("DELETE", path, KEY), {
      params: Promise.resolve({ id: INVITATION_ID }),
    });

    expect(first.status).toBe(200);
    expect(first.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await first.json()).toEqual({ success: true });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await retry.json()).toEqual({ success: true });
    expect(deletion.delete).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:DELETE:/api/team/invite/{param}",
        p_response_status: 200,
        p_response_body: { success: true },
      }),
    );
  });

  it("fails a keyed revoke closed when the provider lookup is ambiguous", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: null,
      error: { code: "08006", message: "provider unavailable" },
    });
    const from = vi.fn(() => lookup);
    const rpc = makeRpc();
    allow({ from, rpc });

    const response = await REVOKE(
      pathRequest("DELETE", `/api/team/invite/${INVITATION_ID}`, KEY),
      { params: Promise.resolve({ id: INVITATION_ID }) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "fail_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:DELETE:/api/team/invite/{param}",
        p_idempotency_key: KEY,
      }),
    );
  });

  it("creates one resend row and replays it without a second insert", async () => {
    const original = queryEndingIn("maybeSingle", {
      data: {
        id: INVITATION_ID,
        email: "invitee@example.com",
        role: "manager",
        accepted_at: null,
      },
      error: null,
    });
    const insertion = queryEndingIn("single", {
      data: inviteRow(),
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(insertion);
    const replayBody = {
      ...inviteRow(),
      inviteUrl: `http://localhost:3000/invite/${"a".repeat(48)}`,
    };
    const rpc = makeRpc([
      claimed,
      {
        outcome: "replay",
        response_status: 200,
        response_body: replayBody,
        response_headers: {},
      },
    ]);
    allow({ from, rpc });
    const path = `/api/team/invite/${INVITATION_ID}/resend`;

    const first = await RESEND(pathRequest("POST", path, KEY), {
      params: Promise.resolve({ id: INVITATION_ID }),
    });
    const retry = await RESEND(pathRequest("POST", path, KEY), {
      params: Promise.resolve({ id: INVITATION_ID }),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(replayBody);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await retry.json()).toEqual(replayBody);
    expect(insertion.insert).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:POST:/api/team/invite/{param}/resend",
        p_request_hash: createIdempotencyRequestHash({
          id: INVITATION_ID,
        }),
      }),
    );
  });

  it("completes the exact accepted resend response without inserting", async () => {
    const original = queryEndingIn("maybeSingle", {
      data: {
        id: INVITATION_ID,
        email: "invitee@example.com",
        role: "manager",
        accepted_at: CREATED_AT,
      },
      error: null,
    });
    const from = vi.fn(() => original);
    const rpc = makeRpc();
    allow({ from, rpc });
    const path = `/api/team/invite/${INVITATION_ID}/resend`;

    const response = await RESEND(pathRequest("POST", path, KEY), {
      params: Promise.resolve({ id: INVITATION_ID }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message: "Invitation already accepted. No need to resend.",
      },
    });
    expect(original.insert).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:POST:/api/team/invite/{param}/resend",
        p_response_status: 400,
      }),
    );
  });
});
