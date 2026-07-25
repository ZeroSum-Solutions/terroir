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
const { PATCH: REORDER } = await import("./reorder/route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const SECTION_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ITEM_ID = "44444444-4444-4444-8444-444444444444";
const WINE_ID = "55555555-5555-4555-8555-555555555555";
const KEY = "66666666-6666-4666-8666-666666666666";

type CreateItemRow = {
  outcome: string;
  response_status: number;
  response_body: unknown;
  replayed: boolean;
};

function request(
  path: string,
  method: string,
  body?: unknown,
  key: string | null = KEY,
) {
  const headers = new Headers();
  if (key !== null) headers.set("Idempotency-Key", key);
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

type ClaimState = "empty" | "in_progress" | "completed";

function replayingRpc(responseBody: unknown) {
  let state: ClaimState = "empty";
  let completedBody = responseBody;
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_api_idempotency") {
        if (state === "empty") {
          state = "in_progress";
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
        if (state === "in_progress") {
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
        state = "completed";
        completedBody = args.p_response_body;
        return { data: true, error: null };
      }
      if (name === "reorder_wine_list_items") {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  );
  return { rpc };
}

describe("wine-list item idempotency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes a concurrent create and replays the exact committed id", async () => {
    const insertion = deferred<{
      data: CreateItemRow[];
      error: null;
    }>();
    let calls = 0;
    const rpc = vi.fn(async (name: string) => {
      expect(name).toBe("create_wine_list_item_idempotent");
      calls += 1;
      if (calls === 1) return insertion.promise;
      if (calls === 2) {
        return {
          data: [{
            outcome: "idempotency_in_progress",
            response_status: 409,
            response_body: {
              error: {
                code: "idempotency_in_progress",
                message: "A request is still in progress.",
              },
            },
            replayed: false,
          }],
          error: null,
        };
      }
      return {
        data: [{
          outcome: "replay",
          response_status: 200,
          response_body: { id: ITEM_ID },
          replayed: true,
        }],
        error: null,
      };
    });
    const from = vi.fn();
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });
    const body = {
      section_id: SECTION_ID,
      wine_id: WINE_ID,
      glass_price: 14,
      bottle_price: null,
    };

    const first = CREATE(
      request("/api/wine-list-items", "POST", body),
    );
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    const concurrent = await CREATE(
      request("/api/wine-list-items", "POST", body),
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({
      error: { code: "idempotency_in_progress" },
    });

    insertion.resolve({
      data: [{
        outcome: "created",
        response_status: 200,
        response_body: { id: ITEM_ID },
        replayed: false,
      }],
      error: null,
    });
    const created = await first;
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: ITEM_ID });

    const replay = await CREATE(
      request("/api/wine-list-items", "POST", body),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual({ id: ITEM_ID });
    expect(from).not.toHaveBeenCalled();
  });

  it("binds every operation to all normalized, validated identity", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "create_wine_list_item_idempotent") {
          return {
            data: [{
              outcome: "replay",
              response_status: 200,
              response_body: { id: ITEM_ID },
              replayed: true,
            }],
            error: null,
          };
        }
        return {
          data: [{
            outcome: "replay",
            response_status: 200,
            response_body:
              args.p_operation_id === "api:POST:/api/wine-list-items"
                ? { id: ITEM_ID }
                : { ok: true },
            response_headers: {},
          }],
          error: null,
        };
      },
    );
    const from = vi.fn(() => {
      throw new Error("replays must not execute business work");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const createBody = {
      section_id: SECTION_ID,
      wine_id: WINE_ID,
      glass_price: 14,
      bottle_price: null,
    };
    const patchBody = {
      bottle_price: 42,
      name_override: " Reserve ",
      hidden: true,
    };
    const orderedIds = [SECOND_ITEM_ID, ITEM_ID];

    expect(
      (
        await CREATE(
          request("/api/wine-list-items", "POST", createBody),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await UPDATE(
          request(
            `/api/wine-list-items/${ITEM_ID}`,
            "PATCH",
            patchBody,
          ),
          { params: Promise.resolve({ id: ITEM_ID }) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await REMOVE(
          request(`/api/wine-list-items/${ITEM_ID}`, "DELETE"),
          { params: Promise.resolve({ id: ITEM_ID }) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await REORDER(
          request("/api/wine-list-items/reorder", "PATCH", {
            orderedIds,
          }),
        )
      ).status,
    ).toBe(200);

    expect(calls).toEqual([
      {
        name: "create_wine_list_item_idempotent",
        args: expect.objectContaining({
          p_restaurant_id: RESTAURANT_ID,
          p_section_id: SECTION_ID,
          p_wine_id: WINE_ID,
          p_glass_price: 14,
          p_request_hash: createIdempotencyRequestHash(createBody),
          p_idempotency_key: KEY,
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id: "api:PATCH:/api/wine-list-items/{param}",
          p_request_hash: createIdempotencyRequestHash({
            id: ITEM_ID,
            body: patchBody,
          }),
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id: "api:DELETE:/api/wine-list-items/{param}",
          p_request_hash: createIdempotencyRequestHash({ id: ITEM_ID }),
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id: "api:PATCH:/api/wine-list-items/reorder",
          p_request_hash: createIdempotencyRequestHash({ orderedIds }),
        }),
      },
    ]);
    expect(from).not.toHaveBeenCalled();
  });

  it("replays a reorder without invoking its atomic RPC twice", async () => {
    const { rpc } = replayingRpc({ ok: true });
    const from = vi.fn(() => ({
      select: () => ({
        in: async () => ({
          data: [
            {
              id: ITEM_ID,
              section_id: SECTION_ID,
              wine_list_sections: {
                wine_lists: { restaurant_id: RESTAURANT_ID },
              },
            },
            {
              id: SECOND_ITEM_ID,
              section_id: SECTION_ID,
              wine_list_sections: {
                wine_lists: { restaurant_id: RESTAURANT_ID },
              },
            },
          ],
          error: null,
        }),
      }),
    }));
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });
    const body = { orderedIds: [SECOND_ITEM_ID, ITEM_ID] };

    const first = await REORDER(
      request("/api/wine-list-items/reorder", "PATCH", body),
    );
    const replay = await REORDER(
      request("/api/wine-list-items/reorder", "PATCH", body),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual({ ok: true });
    expect(
      rpc.mock.calls.filter(
        ([name]) => name === "reorder_wine_list_items",
      ),
    ).toHaveLength(1);
  });

  it("rejects malformed keys before any item read or write", async () => {
    const from = vi.fn();
    const rpc = vi.fn();
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const responses = await Promise.all([
      CREATE(
        request(
          "/api/wine-list-items",
          "POST",
          { section_id: SECTION_ID, wine_id: WINE_ID },
          "bad key",
        ),
      ),
      UPDATE(
        request(
          `/api/wine-list-items/${ITEM_ID}`,
          "PATCH",
          { hidden: true },
          "bad key",
        ),
        { params: Promise.resolve({ id: ITEM_ID }) },
      ),
      REMOVE(
        request(
          `/api/wine-list-items/${ITEM_ID}`,
          "DELETE",
          undefined,
          "bad key",
        ),
        { params: Promise.resolve({ id: ITEM_ID }) },
      ),
      REORDER(
        request(
          "/api/wine-list-items/reorder",
          "PATCH",
          { orderedIds: [ITEM_ID] },
          "bad key",
        ),
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([
      400, 400, 400, 400,
    ]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({
        error: { code: "invalid_idempotency_key" },
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
