import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

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

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/scans/${SCAN_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function makeSupabase(options: {
  fetch?: { data: unknown; error: unknown };
  update?: { error: unknown };
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
  return { supabase: { from }, from, update, fetchFilters, updateFilters };
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
});
