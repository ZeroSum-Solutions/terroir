import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * /api/wine-lists/[id] route tests (BND-029 / DEBT-006).
 *
 * Behavioural coverage replaces the previous readFileSync-based grep
 * tests. BND-008 criterion 2 — cross-tenant PATCH/DELETE must 404 even
 * if RLS would, bypassed, hand back the row — is enforced via a mock
 * that simulates "RLS bypassed" by storing rows for both restaurants
 * and applying only the filters the route actually issues. If the route
 * ever drops the `restaurant_id` filter, cross-tenant rows leak into
 * the result set and the 404 assertions break loudly.
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { PATCH, DELETE } = await import("./route");

type Row = { id: string; restaurant_id: string };

/**
 * Build a mock supabase client whose `wine_lists` table holds `rows`. It
 * mimics the real client's chained-builder pattern: every `.eq(col, val)`
 * records a filter, and the terminal `.select()` returns rows that match
 * EVERY recorded filter. If the route drops a filter, the match set widens
 * to include cross-tenant rows — which is exactly the RLS-bypassed scenario
 * BND-008 is defending against.
 */
// Module-level capture for PATCH payload assertions and an error-injection
// switch for 500 tests. Reset inside each test's beforeEach.
let lastUpdatePayload: Record<string, unknown> | null = null;
let selectError: { message: string } | null = null;

function makeSupabase(rows: Row[]) {
  return {
    from: (_table: string) => {
      const filters: Array<[string, string]> = [];
      const chain = {
        update: (payload: Record<string, unknown>) => {
          lastUpdatePayload = payload;
          return chain;
        },
        delete: () => chain,
        eq: (col: string, val: string) => {
          filters.push([col, val]);
          return chain;
        },
        select: async (_cols?: string) => {
          if (selectError) return { data: null, error: selectError };
          const matched = rows.filter((r) =>
            filters.every(([col, val]) => {
              if (col === "id") return r.id === val;
              if (col === "restaurant_id") return r.restaurant_id === val;
              return true;
            }),
          );
          return { data: matched, error: null };
        },
        then: undefined,
      };
      return chain;
    },
  };
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/wine-lists/list-a", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function deleteRequest() {
  return new Request("http://localhost/api/wine-lists/list-a", {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe("PATCH /api/wine-lists/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUpdatePayload = null;
    selectError = null;
  });

  it("returns 404 when the target list belongs to a different restaurant (RLS-bypassed mock)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-B" },
    ]);
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(404);
  });

  it("returns 200 for a same-restaurant update", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects an empty update body with 400", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({}), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(400);
  });

  it("propagates the 401 from requireMembership", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await PATCH(patchRequest({ name: "x" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s on malformed JSON body (distinct from empty-body 400)", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const req = new Request("http://localhost/api/wine-lists/list-a", {
      method: "PATCH",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const res = await PATCH(req, { params: Promise.resolve({ id: "list-a" }) });
    expect(res.status).toBe(400);
  });

  it("filters unsafe fields from the update payload (only allows name + template)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(
      patchRequest({
        name: "clean",
        template: "elegant",
        is_published: true,
        restaurant_id: "restaurant-B",
        slug: "injected",
      }),
      { params: Promise.resolve({ id: "list-a" }) },
    );
    expect(res.status).toBe(200);
    // Critical: only the allowlisted fields made it to the UPDATE payload.
    expect(lastUpdatePayload).toEqual({ name: "clean", template: "elegant" });
    expect(lastUpdatePayload).not.toHaveProperty("is_published");
    expect(lastUpdatePayload).not.toHaveProperty("restaurant_id");
    expect(lastUpdatePayload).not.toHaveProperty("slug");
  });

  it("returns 500 when the Supabase update errors", async () => {
    selectError = { message: "constraint violation" };
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase([
        { id: "list-a", restaurant_id: "restaurant-A" },
      ]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ name: "x" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/wine-lists/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUpdatePayload = null;
    selectError = null;
  });

  it("returns 404 when the target list belongs to a different restaurant (RLS-bypassed mock)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-B" },
    ]);
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 for a same-restaurant delete", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("propagates the 401 from requireMembership", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 500 when the Supabase delete errors", async () => {
    selectError = { message: "constraint violation" };
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase([
        { id: "list-a", restaurant_id: "restaurant-A" },
      ]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(500);
  });
});
