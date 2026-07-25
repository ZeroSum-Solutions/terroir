import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => auth.requireMembership(...args),
}));

const { PATCH } = await import("./route");

const SCAN_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

function lineItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "line-1",
    name: "Barolo",
    producer: "Test Producer",
    vintage: 2019,
    varietal: "Nebbiolo",
    region: "Piedmont",
    qty: 2,
    unitCost: 95,
    currency: "EUR",
    format: "1.5L",
    confidence: 0.92,
    lowFields: ["currency", "format"],
    ...overrides,
  };
}

function makeRequest(body: unknown, key?: string) {
  return new Request(`http://localhost/api/scans/${SCAN_ID}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function makeSupabase(options: {
  fetch?: { data: unknown; error: unknown };
  update?: { error: unknown };
  claim?: unknown;
  complete?: boolean;
} = {}) {
  const fetchFilters: Array<[string, string]> = [];
  const updateFilters: Array<[string, string]> = [];
  const update = vi.fn();
  const fetchBuilder = {
    select: vi.fn(() => fetchBuilder),
    eq: vi.fn((column: string, value: string) => {
      fetchFilters.push([column, value]);
      return fetchBuilder;
    }),
    single: vi.fn(() =>
      Promise.resolve(
        options.fetch ?? { data: { id: SCAN_ID }, error: null },
      ),
    ),
  };
  const updateBuilder = {
    update: vi.fn((payload: unknown) => {
      update(payload);
      return updateBuilder;
    }),
    eq: vi.fn((column: string, value: string) => {
      updateFilters.push([column, value]);
      return updateBuilder;
    }),
    then: (resolve: (value: { error: unknown }) => void) =>
      Promise.resolve(options.update ?? { error: null }).then(resolve),
  };
  const from = vi
    .fn()
    .mockReturnValueOnce(fetchBuilder)
    .mockReturnValueOnce(updateBuilder);
  const rpc = vi.fn((name: string) => {
    if (name === "claim_api_idempotency") {
      return Promise.resolve({
        data: options.claim ?? [{ outcome: "claimed" }],
        error: null,
      });
    }
    if (name === "complete_api_idempotency") {
      return Promise.resolve({
        data: options.complete ?? true,
        error: null,
      });
    }
    return Promise.resolve({ data: true, error: null });
  });
  return {
    supabase: { from, rpc },
    from,
    rpc,
    update,
    fetchFilters,
    updateFilters,
  };
}

function authorize(supabase: unknown) {
  auth.requireMembership.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "33333333-3333-4333-8333-333333333333" },
    role: "staff",
  });
}

describe("PATCH /api/scans/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["fractional quantity", lineItem({ qty: 1.5 }), {}],
    ["fractional vintage", lineItem({ vintage: 2019.5 }), {}],
    ["out-of-range confidence", lineItem({ confidence: 1.1 }), {}],
    ["false edit markers", lineItem(), { "line-1:name": false }],
  ])("rejects %s before database work", async (_name, item, edits) => {
    const { supabase, from } = makeSupabase();
    authorize(supabase);

    const response = await PATCH(makeRequest({ items: [item], edits }), {
      params: Promise.resolve({ id: SCAN_ID }),
    });

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("distinguishes a missing scan from a lookup failure", async () => {
    const missing = makeSupabase({
      fetch: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    authorize(missing.supabase);
    const missingResponse = await PATCH(
      makeRequest({ items: [lineItem()], edits: {} }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
    expect(missingResponse.status).toBe(404);

    const failed = makeSupabase({
      fetch: {
        data: null,
        error: { code: "XX000", message: "secret database detail" },
      },
    });
    authorize(failed.supabase);
    const failedResponse = await PATCH(
      makeRequest({ items: [lineItem()], edits: {} }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("persists canonical low fields and coherent scan metadata", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await PATCH(
      makeRequest({
        items: [lineItem()],
        edits: { "line-1:name": true },
      }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(db.fetchFilters).toEqual([
      ["id", SCAN_ID],
      ["restaurant_id", RESTAURANT_ID],
    ]);
    expect(db.updateFilters).toEqual([
      ["id", SCAN_ID],
      ["restaurant_id", RESTAURANT_ID],
    ]);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        item_count: 1,
        accuracy_score: 6 / 7,
        final_line_items: [
          expect.objectContaining({
            lowFields: ["currency", "format"],
          }),
        ],
      }),
    );
  });

  it("redacts update failures", async () => {
    const db = makeSupabase({
      update: { error: { message: "sensitive update detail" } },
    });
    authorize(db.supabase);

    const response = await PATCH(
      makeRequest({ items: [lineItem()], edits: {} }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });

  it("binds a keyed save to all normalized params and body fields", async () => {
    const db = makeSupabase();
    authorize(db.supabase);
    const body = {
      items: [lineItem()],
      edits: { "line-1:name": true },
    };

    const response = await PATCH(
      makeRequest(body, "scan_save_key_0001"),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(db.rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: RESTAURANT_ID,
      p_operation_id: "api:PATCH:/api/scans/{param}",
      p_idempotency_key: "scan_save_key_0001",
      p_request_hash: createIdempotencyRequestHash({
        id: SCAN_ID,
        body,
      }),
    });
    expect(db.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_api_idempotency",
      expect.objectContaining({
        p_response_status: 200,
        p_response_body: { success: true, itemCount: 1 },
      }),
    );
  });

  it("replays an exact keyed save without repeating database work", async () => {
    const db = makeSupabase({
      claim: [
        {
          outcome: "replay",
          response_status: 200,
          response_headers: {},
          response_body: { success: true, itemCount: 1 },
        },
      ],
    });
    authorize(db.supabase);

    const response = await PATCH(
      makeRequest(
        { items: [lineItem()], edits: {} },
        "scan_save_key_0002",
      ),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(db.from).not.toHaveBeenCalled();
  });

  it("rejects malformed keyed saves before claims or mutations", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await PATCH(
      makeRequest(
        { items: [lineItem()], edits: {} },
        "bad key!",
      ),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );

    expect(response.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });
});
