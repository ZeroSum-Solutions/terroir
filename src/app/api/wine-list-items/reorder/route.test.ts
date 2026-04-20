import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * PATCH /api/wine-list-items/reorder tests (BND-026).
 *
 * The route is now a thin caller of the `reorder_wine_list_items` RPC
 * (migration 0013). All position updates happen inside plpgsql's
 * implicit transaction, so the route's only job is to validate the
 * payload and surface RPC errors.
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { PATCH } = await import("./route");

type RpcResult = { data: unknown; error: unknown };

function buildSupabase(rpcResult: RpcResult) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  return { supabase: { rpc }, rpc };
}

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
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await PATCH(makeRequest({ orderedIds: ["a", "b"] }));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON", async () => {
    const { supabase, rpc } = buildSupabase({ data: null, error: null });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest("{not json"));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("400s on empty orderedIds (no RPC call)", async () => {
    const { supabase, rpc } = buildSupabase({ data: null, error: null });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: [] }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls reorder_wine_list_items with exact payload on happy path", async () => {
    const { supabase, rpc } = buildSupabase({ data: null, error: null });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const ids = ["item-a", "item-b", "item-c"];
    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("reorder_wine_list_items", {
      p_ordered_ids: ids,
    });
  });

  it("surfaces RPC errors as 500 without attempting partial writes", async () => {
    const { supabase, rpc } = buildSupabase({
      data: null,
      error: { message: "mismatched section", code: "P0001" },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: ["item-a", "item-b"] }));
    expect(res.status).toBe(500);
    expect(rpc).toHaveBeenCalledTimes(1);
    // No direct .from("wine_list_items").update() calls — the RPC is the
    // only write path. This is the key behavioural change from BND-026.
  });
});
