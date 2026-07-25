import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));

const { POST: CREATE } = await import("./route");
const { PATCH: UPDATE, DELETE: REMOVE } = await import("./[id]/route");
const { POST: CLONE } = await import("./[id]/clone/route");
const { POST: PUBLISH, DELETE: UNPUBLISH } = await import(
  "./[id]/publish/route"
);

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

function request(
  path: string,
  method: string,
  body?: unknown,
  key = KEY,
) {
  const headers = new Headers({ "Idempotency-Key": key });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("wine-list lifecycle idempotency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes a concurrent create and replays the exact created id", async () => {
    const insertGate = deferred<{
      data: { id: string };
      error: null;
    }>();
    let claimState: "empty" | "in_progress" | "completed" = "empty";
    let completedBody: unknown = null;
    const businessWrites: string[] = [];

    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_api_idempotency") {
        if (claimState === "empty") {
          claimState = "in_progress";
          return {
            data: [{
              outcome: "claimed",
              response_status: null,
              response_body: null,
              response_headers: null,
            }],
            error: null,
          };
        }
        if (claimState === "in_progress") {
          return {
            data: [{
              outcome: "in_progress",
              response_status: null,
              response_body: null,
              response_headers: null,
            }],
            error: null,
          };
        }
        return {
          data: [{
            outcome: "replay",
            response_status: 200,
            response_body: completedBody,
            response_headers: {},
          }],
          error: null,
        };
      }
      if (name === "complete_api_idempotency") {
        claimState = "completed";
        completedBody = args.p_response_body;
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const from = vi.fn((table: string) => {
      const chain = {
        insert(payload: unknown) {
          businessWrites.push(table);
          if (table === "wine_lists") {
            expect(payload).toEqual({
              name: "Dinner",
              restaurant_id: RESTAURANT_ID,
            });
          }
          return chain;
        },
        select: () => chain,
        single: () => insertGate.promise,
        then: (
          resolve: (value: { data: null; error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
      };
      return chain;
    });

    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const first = CREATE(
      request("/api/wine-lists", "POST", { name: " Dinner " }),
    );
    await vi.waitFor(() => expect(businessWrites).toEqual(["wine_lists"]));

    const concurrent = await CREATE(
      request("/api/wine-lists", "POST", { name: "Dinner" }),
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({
      error: { code: "idempotency_in_progress" },
    });
    expect(businessWrites).toEqual(["wine_lists"]);

    insertGate.resolve({ data: { id: LIST_ID }, error: null });
    const created = await first;
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: LIST_ID });
    expect(businessWrites).toEqual(["wine_lists", "wine_list_sections"]);

    const replay = await CREATE(
      request("/api/wine-lists", "POST", { name: "Dinner" }),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual({ id: LIST_ID });
    expect(businessWrites).toEqual(["wine_lists", "wine_list_sections"]);
  });

  it("binds PATCH and DELETE keys to all normalized validated input", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        data: [{
          outcome: "replay",
          response_status: 200,
          response_body: { ok: true },
          response_headers: {},
        }],
        error: null,
      };
    });
    const from = vi.fn(() => {
      throw new Error("replays must not execute business work");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const patch = await UPDATE(
      request(`/api/wine-lists/${LIST_ID}`, "PATCH", {
        slug: " Dinner-List ",
        archived: true,
      }),
      { params: Promise.resolve({ id: LIST_ID }) },
    );
    const remove = await REMOVE(
      request(`/api/wine-lists/${LIST_ID}`, "DELETE"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(patch.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(calls).toEqual([
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id: "api:PATCH:/api/wine-lists/{param}",
          p_request_hash: createIdempotencyRequestHash({
            id: LIST_ID,
            body: { archived: true, slug: "dinner-list" },
          }),
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id: "api:DELETE:/api/wine-lists/{param}",
          p_request_hash: createIdempotencyRequestHash({ id: LIST_ID }),
        }),
      },
    ]);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before wine-list business work", async () => {
    const from = vi.fn();
    const rpc = vi.fn();
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const response = await CREATE(
      request("/api/wine-lists", "POST", { name: "Dinner" }, "bad key"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("binds clone, publish, and unpublish to normalized complete identities", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const responseBody =
        name === "clone_wine_list_idempotent"
          ? { id: LIST_ID }
          : args.p_publish
            ? { slug: "dinner-list" }
            : { ok: true };
      return {
        data: [{
          outcome: "replay",
          response_status: 200,
          response_body: responseBody,
          replayed: true,
        }],
        error: null,
      };
    });
    const from = vi.fn(() => {
      throw new Error("dedicated replays must not execute table work");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const clone = await CLONE(
      request(`/api/wine-lists/${LIST_ID}/clone`, "POST"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );
    const publish = await PUBLISH(
      request(`/api/wine-lists/${LIST_ID}/publish`, "POST", {
        slug: " Dinner-List ",
      }),
      { params: Promise.resolve({ id: LIST_ID }) },
    );
    const unpublish = await UNPUBLISH(
      request(`/api/wine-lists/${LIST_ID}/publish`, "DELETE"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect([clone.status, publish.status, unpublish.status]).toEqual([
      200, 200, 200,
    ]);
    expect(clone.headers.get("Idempotency-Replayed")).toBe("true");
    expect(publish.headers.get("Idempotency-Replayed")).toBe("true");
    expect(unpublish.headers.get("Idempotency-Replayed")).toBe("true");
    expect(calls).toEqual([
      {
        name: "clone_wine_list_idempotent",
        args: expect.objectContaining({
          p_restaurant_id: RESTAURANT_ID,
          p_wine_list_id: LIST_ID,
          p_idempotency_key: KEY,
          p_request_hash: createIdempotencyRequestHash({ id: LIST_ID }),
        }),
      },
      {
        name: "set_wine_list_publication_idempotent",
        args: expect.objectContaining({
          p_restaurant_id: RESTAURANT_ID,
          p_wine_list_id: LIST_ID,
          p_publish: true,
          p_has_slug: true,
          p_slug: "dinner-list",
          p_idempotency_key: KEY,
          p_request_hash: createIdempotencyRequestHash({
            id: LIST_ID,
            body: { slug: "dinner-list" },
          }),
        }),
      },
      {
        name: "set_wine_list_publication_idempotent",
        args: expect.objectContaining({
          p_restaurant_id: RESTAURANT_ID,
          p_wine_list_id: LIST_ID,
          p_publish: false,
          p_has_slug: false,
          p_idempotency_key: KEY,
          p_request_hash: createIdempotencyRequestHash({ id: LIST_ID }),
        }),
      },
    ]);
    expect(calls[2].args).not.toHaveProperty("p_slug");
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before dedicated publication RPCs", async () => {
    const from = vi.fn();
    const rpc = vi.fn();
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const response = await PUBLISH(
      request(
        `/api/wine-lists/${LIST_ID}/publish`,
        "POST",
        {},
        "bad key",
      ),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("maps a dedicated canonical-identity rejection to a deterministic 400", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "22023", message: "hash mismatch" },
    }));
    auth.requireRole.mockResolvedValue({
      supabase: { from: vi.fn(), rpc },
      restaurantId: RESTAURANT_ID,
    });

    const response = await CLONE(
      request(`/api/wine-lists/${LIST_ID}/clone`, "POST"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_wine_list_clone_request" },
    });
  });

  it("fails closed if an unkeyed dedicated call claims to be a replay", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        outcome: "replay",
        response_status: 200,
        response_body: { id: LIST_ID },
        replayed: true,
      }],
      error: null,
    }));
    auth.requireRole.mockResolvedValue({
      supabase: { from: vi.fn(), rpc },
      restaurantId: RESTAURANT_ID,
    });
    const unkeyed = new NextRequest(
      `http://localhost/api/wine-lists/${LIST_ID}/clone`,
      { method: "POST" },
    );

    const response = await CLONE(unkeyed, {
      params: Promise.resolve({ id: LIST_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error" },
    });
  });
});
