import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockResolveImportBatchRow = vi.fn();
vi.mock("@/domains/import/batch-service", () => ({
  resolveImportBatchRow: (...args: unknown[]) => mockResolveImportBatchRow(...args),
}));

const { PATCH } = await import("./route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";

function request(body: unknown) {
  return new Request(`http://localhost/api/import/batches/${BATCH_ID}/rows/${ROW_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
function params() {
  return Promise.resolve({ id: BATCH_ID, rowId: ROW_ID });
}

function makeSupabase(row: unknown) {
  const eqCalls: Array<[string, unknown]> = [];
  return {
    eqCalls,
    from: vi.fn(() => ({
      select: () => ({
        eq: (c: string, v: unknown) => {
          eqCalls.push([c, v]);
          return {
            eq: (c2: string, v2: unknown) => {
              eqCalls.push([c2, v2]);
              return {
                eq: (c3: string, v3: unknown) => {
                  eqCalls.push([c3, v3]);
                  return { maybeSingle: async () => ({ data: row, error: null }) };
                },
              };
            },
          };
        },
      }),
    })),
  };
}

function allow(supabase: unknown) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("PATCH /api/import/batches/[id]/rows/[rowId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s when the row doesn't belong to this batch/tenant, never calling resolve", async () => {
    allow(makeSupabase(null));
    const response = await PATCH(request({ action: "exclude" }), { params: params() });
    expect(response.status).toBe(404);
    expect(mockResolveImportBatchRow).not.toHaveBeenCalled();
  });

  it("rejects an invalid action", async () => {
    allow(makeSupabase({ id: ROW_ID }));
    const response = await PATCH(request({ action: "delete" }), { params: params() });
    expect(response.status).toBe(400);
  });

  it("scopes the row lookup to id + batch_id + restaurant_id", async () => {
    const supabase = makeSupabase({ id: ROW_ID });
    allow(supabase);
    mockResolveImportBatchRow.mockResolvedValue({ ok: true });
    const response = await PATCH(request({ action: "exclude" }), { params: params() });
    expect(response.status).toBe(200);
    expect(supabase.eqCalls).toEqual([
      ["id", ROW_ID],
      ["batch_id", BATCH_ID],
      ["restaurant_id", "restaurant-a"],
    ]);
  });

  it("surfaces a manual-cost-required rejection as 422", async () => {
    allow(makeSupabase({ id: ROW_ID }));
    mockResolveImportBatchRow.mockResolvedValue({
      ok: false,
      error: { code: "manual_cost_required", message: "A non-negative unit cost is required." },
    });
    const response = await PATCH(request({ action: "include" }), { params: params() });
    expect(response.status).toBe(422);
  });
});
