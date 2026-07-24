import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * PATCH /api/wine-list-items/reorder tests (BND-026 + ARCH-014).
 *
 * The route is now a thin caller of the `reorder_wine_list_items` RPC
 * (migration 0013). All position updates happen inside plpgsql's
 * implicit transaction. ARCH-014 added an ownership pre-check: every
 * orderedId must belong to a wine list owned by the caller's
 * restaurant before the RPC is invoked.
 */

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH } = await import("./route");

type RpcResult = { data: unknown; error: unknown };
type OwnershipRow = {
  id: string;
  section_id: string;
  wine_list_sections: { wine_lists: { restaurant_id: string } };
};

/**
 * Builds a supabase mock that serves:
 *  1. The ownership pre-check —
 *     from('wine_list_items').select(...).in('id', ids)
 *     → returns one ownership row per id in `ownershipRows`.
 *  2. The reorder RPC —
 *     supabase.rpc('reorder_wine_list_items', { p_ordered_ids })
 *     → returns `rpcResult`.
 *
 * If `ownershipRows` has FEWER rows than the request ids, the helper
 * returns a short list — simulating "one of the ids doesn't exist
 * or is cross-tenant", which the route should reject as 404.
 */
function buildSupabase(opts: {
  rpcResult: RpcResult;
  ownershipRows: OwnershipRow[];
}) {
  const rpc = vi.fn(() => Promise.resolve(opts.rpcResult));
  const supabase = {
    from: (_t: string) => ({
      select: () => ({
        in: () => ({
          then: (
            resolve: (v: { data: OwnershipRow[]; error: null }) => void,
          ) => resolve({ data: opts.ownershipRows, error: null }),
        }),
      }),
    }),
    rpc,
  };
  return { supabase, rpc };
}

function ownedRow(
  id: string,
  restaurantId: string,
  sectionId = "11111111-1111-4111-8111-111111111111",
): OwnershipRow {
  return {
    id,
    section_id: sectionId,
    wine_list_sections: { wine_lists: { restaurant_id: restaurantId } },
  };
}

const ITEM_A = "22222222-2222-4222-8222-222222222222";
const ITEM_B = "33333333-3333-4333-8333-333333333333";
const ITEM_C = "44444444-4444-4444-8444-444444444444";

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/wine-list-items/reorder", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("PATCH /api/wine-list-items/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when requireMembership returns a NextResponse", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await PATCH(makeRequest({ orderedIds: ["a", "b"] }));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON", async () => {
    const { supabase, rpc } = buildSupabase({
      rpcResult: { data: null, error: null },
      ownershipRows: [],
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest("{not json"));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("400s on empty orderedIds (no RPC call)", async () => {
    const { supabase, rpc } = buildSupabase({
      rpcResult: { data: null, error: null },
      ownershipRows: [],
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: [] }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls reorder_wine_list_items with exact payload on happy path", async () => {
    const ids = [ITEM_A, ITEM_B, ITEM_C];
    const { supabase, rpc } = buildSupabase({
      rpcResult: { data: null, error: null },
      ownershipRows: ids.map((id) => ownedRow(id, "r-1")),
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("reorder_wine_list_items", {
      p_ordered_ids: ids,
    });
  });

  it("surfaces RPC errors as 500 without attempting partial writes", async () => {
    const ids = [ITEM_A, ITEM_B];
    const { supabase, rpc } = buildSupabase({
      rpcResult: {
        data: null,
        error: { message: "mismatched section", code: "P0001" },
      },
      ownershipRows: ids.map((id) => ownedRow(id, "r-1")),
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(500);
    expect(rpc).toHaveBeenCalledTimes(1);
    // No direct .from("wine_list_items").update() calls — the RPC is the
    // only write path. This is the key behavioural change from BND-026.
  });

  // ARCH-014: ownership pre-check
  it("404s when any orderedId belongs to another restaurant (no RPC call)", async () => {
    const ids = [ITEM_A, ITEM_B];
    const { supabase, rpc } = buildSupabase({
      rpcResult: { data: null, error: null },
      ownershipRows: [ownedRow(ITEM_A, "r-1"), ownedRow(ITEM_B, "r-2")],
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("404s when a requested id doesn't exist (no RPC call)", async () => {
    const ids = [ITEM_A, ITEM_B];
    const { supabase, rpc } = buildSupabase({
      rpcResult: { data: null, error: null },
      // Only one row returned for two ids → len mismatch → reject.
      ownershipRows: [ownedRow(ITEM_A, "r-1")],
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});
