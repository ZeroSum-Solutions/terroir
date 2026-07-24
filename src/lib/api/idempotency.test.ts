import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => sentry);

import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
  withIdempotency,
} from "./idempotency";

const KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HASH = createIdempotencyRequestHash({ quantity: 2, wineId: "wine-a" });
const BASE_OPTIONS = {
  restaurantId: "restaurant-a",
  operationId: "api:POST:/api/pour",
  key: KEY,
  requestHash: HASH,
} as const;

type RpcResult = { data: unknown; error: unknown };

function clientWithRpc(
  implementation: (
    operation: string,
    args: Record<string, unknown>,
  ) => Promise<RpcResult>,
) {
  const rpc = vi.fn(implementation);
  return {
    client: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
  };
}

function claimRow(
  outcome:
    | "claimed"
    | "replay"
    | "in_progress"
    | "mismatch"
    | "expired"
    | "outcome_unknown",
  overrides: Record<string, unknown> = {},
) {
  return {
    outcome,
    response_status: null,
    response_body: null,
    response_headers: null,
    ...overrides,
  };
}

function successfulClient() {
  return clientWithRpc(async (operation) => {
    if (operation === "claim_api_idempotency") {
      return { data: [claimRow("claimed")], error: null };
    }
    if (
      operation === "complete_api_idempotency" ||
      operation === "release_api_idempotency" ||
      operation === "fail_api_idempotency"
    ) {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${operation}`);
  });
}

describe("isValidIdempotencyKey", () => {
  it("accepts UUID and opaque URL-safe keys", () => {
    expect(isValidIdempotencyKey(KEY)).toBe(true);
    expect(isValidIdempotencyKey("client_retry-0001")).toBe(true);
  });

  it("rejects missing, short, oversized, and unsafe keys", () => {
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey("1234567")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("same key!")).toBe(false);
  });
});

describe("createIdempotencyRequestHash", () => {
  it("is stable across object key order but changes with request data", () => {
    const first = createIdempotencyRequestHash({
      wine: { id: "wine-a", quantity: 2 },
      note: null,
    });
    const reordered = createIdempotencyRequestHash({
      note: null,
      wine: { quantity: 2, id: "wine-a" },
    });
    const changed = createIdempotencyRequestHash({
      note: null,
      wine: { quantity: 3, id: "wine-a" },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("length-prefixes binary parts so boundaries cannot collide", () => {
    const first = createIdempotencyRequestHash(
      { type: "upload" },
      Buffer.from("ab"),
      Buffer.from("c"),
    );
    const second = createIdempotencyRequestHash(
      { type: "upload" },
      Buffer.from("a"),
      Buffer.from("bc"),
    );

    expect(first).not.toBe(second);
  });

  it("rejects payload values JSON cannot represent truthfully", () => {
    expect(() =>
      createIdempotencyRequestHash({ amount: Number.NaN }),
    ).toThrow("non-finite");
    expect(() =>
      createIdempotencyRequestHash({ amount: BigInt(1) }),
    ).toThrow("Unsupported");
  });
});

describe("withIdempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs without storage or idempotency headers when the key is omitted", async () => {
    const { client, rpc } = successfulClient();
    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      key: null,
      handler: vi.fn().mockResolvedValue({
        status: 201,
        body: { id: "created" },
      }),
    });

    expect(result).toEqual({
      status: 201,
      body: { id: "created" },
      replayed: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claims, executes, completes, and marks a first response", async () => {
    const { client, rpc } = successfulClient();
    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      handler: vi.fn().mockResolvedValue({
        status: 201,
        body: { id: "created" },
      }),
    });

    expect(result).toEqual({
      status: 201,
      body: { id: "created" },
      replayed: false,
      headers: { "Idempotency-Replayed": "false" },
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: "restaurant-a",
      p_operation_id: "api:POST:/api/pour",
      p_idempotency_key: KEY,
      p_request_hash: HASH,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "complete_api_idempotency", {
      p_restaurant_id: "restaurant-a",
      p_operation_id: "api:POST:/api/pour",
      p_idempotency_key: KEY,
      p_request_hash: HASH,
      p_response_status: 201,
      p_response_body: { id: "created" },
      p_response_headers: {},
    });
  });

  it("replays the exact completed response without executing the handler", async () => {
    const { client } = clientWithRpc(async () => ({
      data: [
        claimRow("replay", {
          response_status: 201,
          response_body: { id: "existing" },
          response_headers: { ETag: "\"created\"" },
        }),
      ],
      error: null,
    }));
    const handler = vi.fn();

    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 201,
      body: { id: "existing" },
      replayed: true,
      headers: {
        ETag: "\"created\"",
        "Idempotency-Replayed": "true",
      },
    });
  });

  it("stores and returns only validated replayable response headers", async () => {
    const { client, rpc } = successfulClient();
    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      handler: vi.fn().mockResolvedValue({
        status: 202,
        body: { accepted: true },
        headers: {
          ETag: "\"accepted\"",
          Location: "/api/jobs/job-a",
        },
      }),
    });

    expect(result.headers).toEqual({
      ETag: "\"accepted\"",
      Location: "/api/jobs/job-a",
      "Idempotency-Replayed": "false",
    });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_response_headers: {
          ETag: "\"accepted\"",
          Location: "/api/jobs/job-a",
        },
      }),
    );
  });

  it("fails closed and marks the outcome unknown for unsafe response headers", async () => {
    const { client, rpc } = successfulClient();
    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      handler: vi.fn().mockResolvedValue({
        status: 200,
        body: { ok: true },
        headers: { "Set-Cookie": "session=secret" },
      }),
    });

    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "idempotency_unavailable" } },
    });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "fail_api_idempotency",
      expect.anything(),
    );
    expect(rpc).not.toHaveBeenCalledWith(
      "complete_api_idempotency",
      expect.anything(),
    );
  });

  it.each([
    ["in_progress", "idempotency_in_progress", "still in progress", true],
    ["mismatch", "idempotency_key_reused", "different request", false],
    ["expired", "idempotency_key_expired", "expired", false],
    [
      "outcome_unknown",
      "idempotency_outcome_unknown",
      "outcome is unknown",
      false,
    ],
  ] as const)(
    "returns a nested 409 for %s",
    async (outcome, code, message, hasRetryAfter) => {
      const { client } = clientWithRpc(async () => ({
        data: [claimRow(outcome)],
        error: null,
      }));
      const handler = vi.fn();

      const result = await withIdempotency({
        ...BASE_OPTIONS,
        supabase: client,
        handler,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 409,
        body: {
          error: {
            code,
            message: expect.stringContaining(message),
          },
        },
        replayed: false,
        ...(hasRetryAfter ? { headers: { "Retry-After": "1" } } : {}),
      });
    },
  );

  it("fails closed with 503 when claiming is unavailable", async () => {
    const providerError = { code: "08006", message: "database unavailable" };
    const { client } = clientWithRpc(async () => ({
      data: null,
      error: providerError,
    }));
    const handler = vi.fn();

    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      handler,
    });

    expect(result).toEqual({
      status: 503,
      body: {
        error: {
          code: "idempotency_unavailable",
          message: "Request idempotency is temporarily unavailable.",
        },
      },
      replayed: false,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(sentry.captureException).toHaveBeenCalledWith(
      providerError,
      expect.objectContaining({
        tags: { surface: "idempotency", phase: "claim" },
      }),
    );
  });

  it("fails closed with 503 on malformed claim or replay metadata", async () => {
    const malformedClaim = clientWithRpc(async () => ({
      data: [{ outcome: "surprise" }],
      error: null,
    }));
    const malformedReplay = clientWithRpc(async () => ({
      data: [
        claimRow("replay", {
          response_status: 200,
          response_body: { ok: true },
          response_headers: { ETag: 42 },
        }),
      ],
      error: null,
    }));
    const unsafeReplay = clientWithRpc(async () => ({
      data: [
        claimRow("replay", {
          response_status: 200,
          response_body: { ok: true },
          response_headers: { "Set-Cookie": "session=secret" },
        }),
      ],
      error: null,
    }));

    for (const client of [
      malformedClaim.client,
      malformedReplay.client,
      unsafeReplay.client,
    ]) {
      const result = await withIdempotency({
        ...BASE_OPTIONS,
        supabase: client,
        handler: vi.fn(),
      });
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({
        error: { code: "idempotency_unavailable" },
      });
    }
  });

  it("fails closed with 503 when completion cannot be persisted", async () => {
    const providerError = { code: "08006", message: "completion unavailable" };
    const { client } = clientWithRpc(async (operation) =>
      operation === "claim_api_idempotency"
        ? { data: [claimRow("claimed")], error: null }
        : { data: null, error: providerError },
    );

    const result = await withIdempotency({
      ...BASE_OPTIONS,
      supabase: client,
      handler: vi.fn().mockResolvedValue({
        status: 200,
        body: { ok: true },
      }),
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
  });

  it("marks an ambiguous handler throw outcome unknown by default", async () => {
    const { client, rpc } = successfulClient();
    const failure = new Error("commit status unknown");

    await expect(
      withIdempotency({
        ...BASE_OPTIONS,
        supabase: client,
        handler: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);

    expect(rpc).toHaveBeenNthCalledWith(2, "fail_api_idempotency", {
      p_restaurant_id: "restaurant-a",
      p_operation_id: "api:POST:/api/pour",
      p_idempotency_key: KEY,
      p_request_hash: HASH,
    });
    expect(rpc).not.toHaveBeenCalledWith(
      "release_api_idempotency",
      expect.anything(),
    );
  });

  it("releases an atomic no-commit failure only when explicitly requested", async () => {
    const { client, rpc } = successfulClient();
    const failure = new Error("transaction rolled back");

    await expect(
      withIdempotency({
        ...BASE_OPTIONS,
        supabase: client,
        releaseOnError: true,
        handler: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);

    expect(rpc).toHaveBeenNthCalledWith(2, "release_api_idempotency", {
      p_restaurant_id: "restaurant-a",
      p_operation_id: "api:POST:/api/pour",
      p_idempotency_key: KEY,
      p_request_hash: HASH,
    });
  });

  it("surfaces and records a failed explicit release", async () => {
    const releaseError = { code: "08006", message: "release unavailable" };
    const { client } = clientWithRpc(async (operation) =>
      operation === "claim_api_idempotency"
        ? { data: [claimRow("claimed")], error: null }
        : { data: null, error: releaseError },
    );

    await expect(
      withIdempotency({
        ...BASE_OPTIONS,
        supabase: client,
        releaseOnError: true,
        handler: vi.fn().mockRejectedValue(new Error("rolled back")),
      }),
    ).rejects.toBe(releaseError);
    expect(sentry.captureException).toHaveBeenCalledWith(
      releaseError,
      expect.objectContaining({
        tags: { surface: "idempotency", phase: "release" },
      }),
    );
  });
});
