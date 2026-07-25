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
const { PATCH: RENAME, DELETE: REMOVE } = await import("./[id]/route");
const { PATCH: REORDER } = await import("./reorder/route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_SECTION_ID = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";

function request(path: string, method: string, body?: unknown, key = KEY) {
  const headers = new Headers({ "Idempotency-Key": key });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("wine-list section idempotency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds all four operations to normalized validated identity and replays without business work", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        expect(name).toBe("claim_api_idempotency");
        const operation = String(args.p_operation_id);
        return {
          data: [{
            outcome: "replay",
            response_status:
              operation === "api:POST:/api/wine-list-sections" ? 201 : 200,
            response_body:
              operation === "api:POST:/api/wine-list-sections"
                ? {
                    id: SECTION_ID,
                    wine_list_id: LIST_ID,
                    name: "Reds",
                    position: 1,
                    created_at: "2026-07-24T00:00:00.000Z",
                  }
                : { ok: true },
            response_headers: {},
          }],
          error: null,
        };
      },
    );
    const from = vi.fn(() => {
      throw new Error("replay must not execute section business work");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const create = await CREATE(
      request("/api/wine-list-sections", "POST", {
        wine_list_id: LIST_ID,
        name: " Reds ",
      }),
    );
    const rename = await RENAME(
      request(`/api/wine-list-sections/${SECTION_ID}`, "PATCH", {
        name: " Reserve ",
      }),
      { params: Promise.resolve({ id: SECTION_ID }) },
    );
    const remove = await REMOVE(
      request(`/api/wine-list-sections/${SECTION_ID}`, "DELETE"),
      { params: Promise.resolve({ id: SECTION_ID }) },
    );
    const orderedIds = [SECOND_SECTION_ID, SECTION_ID];
    const reorder = await REORDER(
      request("/api/wine-list-sections/reorder", "PATCH", {
        orderedIds,
      }),
    );

    expect([
      create.status,
      rename.status,
      remove.status,
      reorder.status,
    ]).toEqual([201, 200, 200, 200]);
    for (const response of [create, rename, remove, reorder]) {
      expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    }
    expect(from).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_restaurant_id: RESTAURANT_ID,
          p_operation_id: "api:POST:/api/wine-list-sections",
          p_idempotency_key: KEY,
          p_request_hash: createIdempotencyRequestHash({
            wine_list_id: LIST_ID,
            name: "Reds",
          }),
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id:
            "api:PATCH:/api/wine-list-sections/{param}",
          p_request_hash: createIdempotencyRequestHash({
            id: SECTION_ID,
            body: { name: "Reserve" },
          }),
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id:
            "api:DELETE:/api/wine-list-sections/{param}",
          p_request_hash: createIdempotencyRequestHash({
            id: SECTION_ID,
          }),
        }),
      },
      {
        name: "claim_api_idempotency",
        args: expect.objectContaining({
          p_operation_id:
            "api:PATCH:/api/wine-list-sections/reorder",
          p_request_hash: createIdempotencyRequestHash({ orderedIds }),
        }),
      },
    ]);
  });

  it("rejects a malformed key before section business work", async () => {
    const from = vi.fn();
    const rpc = vi.fn();
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: RESTAURANT_ID,
    });

    const response = await CREATE(
      request(
        "/api/wine-list-sections",
        "POST",
        { wine_list_id: LIST_ID, name: "Reds" },
        "bad key",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
