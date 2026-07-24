import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "./idempotency";
import { idempotentMutationResponse } from "./idempotent-mutation";

const KEY = "11111111-1111-4111-8111-111111111111";

function request(key?: string): Pick<NextRequest, "headers"> {
  return new Request("http://localhost/api/open-bottles", {
    headers: key ? { "Idempotency-Key": key } : {},
  }) as unknown as Pick<NextRequest, "headers">;
}

function supabase(
  implementation: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>,
) {
  return { rpc: vi.fn(implementation) };
}

describe("idempotentMutationResponse", () => {
  it("rejects a malformed supplied key before storage or business work", async () => {
    const client = supabase(async () => ({ data: null, error: null }));
    const handler = vi.fn(async () => ({
      status: 201,
      body: { created: true },
    }));

    const response = await idempotentMutationResponse({
      request: request("bad key"),
      supabase: client as never,
      restaurantId: "restaurant-a",
      operationId: "api:POST:/api/open-bottles",
      payload: { wine_id: "wine-a" },
      handler,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves missing-key behavior without touching idempotency storage", async () => {
    const client = supabase(async () => ({ data: null, error: null }));

    const response = await idempotentMutationResponse({
      request: request(),
      supabase: client as never,
      restaurantId: "restaurant-a",
      operationId: "api:POST:/api/open-bottles",
      payload: { wine_id: "wine-a" },
      handler: async () => ({
        status: 201,
        body: { created: true },
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("claims with the canonical fingerprint and completes the exact result", async () => {
    const client = supabase(async (name) => {
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
      if (name === "complete_api_idempotency") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    const response = await idempotentMutationResponse({
      request: request(KEY),
      supabase: client as never,
      restaurantId: "restaurant-a",
      operationId: "api:POST:/api/open-bottles",
      payload: { z: 1, a: "two" },
      binaryParts: [new Uint8Array([1, 2, 3])],
      handler: async () => ({
        status: 201,
        body: { created: true },
        headers: { Location: "/created" },
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(response.headers.get("Location")).toBe("/created");
    expect(client.rpc).toHaveBeenNthCalledWith(
      1,
      "claim_api_idempotency",
      expect.objectContaining({
        p_operation_id: "api:POST:/api/open-bottles",
        p_request_hash: createIdempotencyRequestHash(
          { a: "two", z: 1 },
          new Uint8Array([1, 2, 3]),
        ),
      }),
    );
    expect(client.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_response_status: 201,
        p_response_body: { created: true },
        p_response_headers: { Location: "/created" },
      }),
    );
  });

  it("replays a completed result without invoking business work", async () => {
    const client = supabase(async (name) => {
      if (name !== "claim_api_idempotency") {
        throw new Error(`unexpected RPC ${name}`);
      }
      return {
        data: [
          {
            outcome: "replay",
            response_status: 202,
            response_headers: { Location: "/jobs/job-a" },
            response_body: { jobId: "job-a" },
          },
        ],
        error: null,
      };
    });
    const handler = vi.fn(async () => ({
      status: 202,
      body: { jobId: "new" },
    }));

    const response = await idempotentMutationResponse({
      request: request(KEY),
      supabase: client as never,
      restaurantId: "restaurant-a",
      operationId: "api:POST:/api/open-bottles",
      payload: { wine_id: "wine-a" },
      handler,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(response.headers.get("Location")).toBe("/jobs/job-a");
    expect(await response.json()).toEqual({ jobId: "job-a" });
    expect(handler).not.toHaveBeenCalled();
  });
});
