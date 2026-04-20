import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

/**
 * /api/wine-lists/[id] route tests.
 *
 * Static checks: route continues to use requireMembership (post-BND-003),
 * and every Supabase call on wine_lists carries an `.eq("restaurant_id"`
 * filter (BND-008 acceptance criterion 1).
 *
 * Behavioural checks: BND-008 acceptance criterion 2 — a cross-tenant
 * PATCH/DELETE must return 404 even if the underlying Supabase client
 * would, with RLS bypassed, hand back the row. The mock simulates
 * "RLS bypassed" by storing rows for both restaurants and applying only
 * the filters the route actually issues.
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { PATCH, DELETE } = await import("./route");

describe("wine-lists [id] route — static guards", () => {
  const routeContent = readFileSync(join(__dirname, "route.ts"), "utf-8");

  it("uses requireMembership, not requireAuth", () => {
    expect(routeContent).toContain("requireMembership");
    expect(routeContent).not.toMatch(/requireAuth[^C]/);
  });

  it("every wine_lists query is scoped by restaurant_id (BND-008 criterion 1)", () => {
    // Every .from("wine_lists") occurrence must be paired with a
    // subsequent `.eq("restaurant_id"` before the statement terminates.
    // A simple, strict check: each `.from("wine_lists")` substring must be
    // followed (within the rest of the file) by at least one
    // `.eq("restaurant_id"`.
    const occurrences = routeContent.split('.from("wine_lists")');
    // occurrences.length - 1 is the number of .from("wine_lists") calls.
    // For each one, the remainder of the file (or block) must contain
    // .eq("restaurant_id".  Because there's exactly one such call per
    // handler, a count match is sufficient.
    const fromCount = occurrences.length - 1;
    const restaurantEqCount = (
      routeContent.match(/\.eq\("restaurant_id"/g) ?? []
    ).length;
    expect(fromCount).toBeGreaterThan(0);
    expect(restaurantEqCount).toBeGreaterThanOrEqual(fromCount);
  });
});

type Row = { id: string; restaurant_id: string };

/**
 * Build a mock supabase client whose `wine_lists` table holds `rows`. It
 * mimics the real client's chained-builder pattern: every `.eq(col, val)`
 * records a filter, and the terminal `.select()` returns rows that match
 * EVERY recorded filter. If the route drops a filter, the match set widens
 * to include cross-tenant rows — which is exactly the RLS-bypassed scenario
 * BND-008 is defending against.
 */
function makeSupabase(rows: Row[]) {
  return {
    from: (_table: string) => {
      const filters: Array<[string, string]> = [];
      const chain = {
        update: () => chain,
        delete: () => chain,
        eq: (col: string, val: string) => {
          filters.push([col, val]);
          return chain;
        },
        select: async (_cols?: string) => {
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
});

describe("DELETE /api/wine-lists/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
