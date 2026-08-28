import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * PATCH /api/wine-list-sections/reorder tests (BND-162).
 *
 * SCALE: the route used to do one ownership-check SELECT plus one
 * position UPDATE per section id — 2N round trips for an N-section
 * reorder. It now does exactly one ownership-check SELECT (which also
 * supplies the name/wine_list_id the upsert needs) plus one batched
 * upsert, regardless of N.
 */

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH } = await import("./route");

type SelectResult = { data: unknown[] | null; error: unknown };
type OwnedRow = {
  id: string;
  name: string;
  wine_list_id: string;
  wine_lists: { restaurant_id: string };
};

/**
 * Builds a supabase mock that serves:
 *  1. The ownership + field fetch —
 *     from('wine_list_sections').select(...).in('id', ids)
 *     → resolves with `selectResult`.
 *  2. The batched upsert —
 *     from('wine_list_sections').upsert([...])
 *     → resolves with `upsertResult`.
 */
function buildSupabase(opts: {
  selectResult: SelectResult;
  upsertResult: { error: unknown };
}) {
  const select = vi.fn(() => ({
    in: vi.fn(() => Promise.resolve(opts.selectResult)),
  }));
  const upsert = vi.fn(() => Promise.resolve(opts.upsertResult));
  const supabase = {
    from: (_t: string) => ({ select, upsert }),
  };
  return { supabase, select, upsert };
}

function ownedRow(id: string, restaurantId: string, position: number): OwnedRow {
  return {
    id,
    name: `Section ${position}`,
    wine_list_id: "list-1",
    wine_lists: { restaurant_id: restaurantId },
  };
}

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/wine-list-sections/reorder", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("PATCH /api/wine-list-sections/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when requireRole returns a NextResponse", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await PATCH(makeRequest({ orderedIds: ["a", "b"] }));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON", async () => {
    const { supabase, upsert } = buildSupabase({
      selectResult: { data: [], error: null },
      upsertResult: { error: null },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest("{not json"));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("400s on empty orderedIds (no queries)", async () => {
    const { supabase, select, upsert } = buildSupabase({
      selectResult: { data: [], error: null },
      upsertResult: { error: null },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await PATCH(makeRequest({ orderedIds: [] }));
    expect(res.status).toBe(400);
    expect(select).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("batches an N-section reorder into exactly one select and one upsert", async () => {
    const ids = ["sec-a", "sec-b", "sec-c", "sec-d", "sec-e"];
    const { supabase, select, upsert } = buildSupabase({
      selectResult: {
        data: ids.map((id, i) => ownedRow(id, "r-1", i)),
        error: null,
      },
      upsertResult: { error: null },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await PATCH(makeRequest({ orderedIds: ids }));

    expect(res.status).toBe(200);
    // Exactly one round trip for the ownership check and one for the
    // write, regardless of section count — the old code made 2N.
    expect(select).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith([
      { id: "sec-a", position: 0, name: "Section 0", wine_list_id: "list-1" },
      { id: "sec-b", position: 1, name: "Section 1", wine_list_id: "list-1" },
      { id: "sec-c", position: 2, name: "Section 2", wine_list_id: "list-1" },
      { id: "sec-d", position: 3, name: "Section 3", wine_list_id: "list-1" },
      { id: "sec-e", position: 4, name: "Section 4", wine_list_id: "list-1" },
    ]);
  });

  it("surfaces upsert errors as 500", async () => {
    const ids = ["sec-a", "sec-b"];
    const { supabase, upsert } = buildSupabase({
      selectResult: {
        data: ids.map((id, i) => ownedRow(id, "r-1", i)),
        error: null,
      },
      upsertResult: { error: { message: "constraint violation" } },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(500);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("404s when any orderedId belongs to another restaurant (no upsert)", async () => {
    const ids = ["sec-a", "sec-b"];
    const { supabase, upsert } = buildSupabase({
      selectResult: {
        data: [ownedRow("sec-a", "r-1", 0), ownedRow("sec-b", "r-2", 1)],
        error: null,
      },
      upsertResult: { error: null },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("404s when a requested id doesn't exist (no upsert)", async () => {
    const ids = ["sec-a", "sec-b"];
    const { supabase, upsert } = buildSupabase({
      selectResult: {
        // Only one row returned for two ids → len mismatch → reject.
        data: [ownedRow("sec-a", "r-1", 0)],
        error: null,
      },
      upsertResult: { error: null },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await PATCH(makeRequest({ orderedIds: ids }));
    expect(res.status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
  });
});
