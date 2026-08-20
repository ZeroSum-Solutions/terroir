import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { GET } = await import("./route");

type Table = "memberships" | "pour_events" | "stock_adjustments" | "bottle_closeouts";

function makeSupabase(rows: Record<Table, unknown[]>) {
  const ranges: Record<Table, Array<[number, number]>> = {
    memberships: [],
    pour_events: [],
    stock_adjustments: [],
    bottle_closeouts: [],
  };
  const selects: Record<Table, string[]> = {
    memberships: [],
    pour_events: [],
    stock_adjustments: [],
    bottle_closeouts: [],
  };
  return {
    ranges,
    selects,
    from(table: Table) {
      const query = {
        select(columns: string) {
          selects[table].push(columns);
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        async range(from: number, to: number) {
          ranges[table].push([from, to]);
          return { data: rows[table].slice(from, to + 1), error: null };
        },
      };
      return query;
    },
  };
}

describe("GET /api/member-analytics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("EV-7.4: returns the staff 403 without reading analytics tables", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Role owner or manager required." }, { status: 403 }),
    );

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("assembles actor-attributed pours, comps, and close-out variance", async () => {
    const supabase = makeSupabase({
      memberships: [
        { id: "m-a", user_id: "u-a", role: "manager" },
        { id: "m-b", user_id: "u-b", role: "staff" },
      ],
      pour_events: [
        { actor_user_id: "u-a", ml_delta: 150, kind: "pour" },
        { actor_user_id: "u-a", ml_delta: 125, kind: "pour" },
      ],
      stock_adjustments: [
        { acting_user_id: "u-a", kind: "comp" },
        { acting_user_id: "u-b", kind: "adjustment" },
      ],
      bottle_closeouts: [
        { closed_by: "u-b", variance_ml: -30 },
      ],
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-a",
      user: { id: "u-a" },
      role: "manager",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.members).toEqual([
      expect.objectContaining({
        memberId: "m-a",
        userId: "u-a",
        pourCount: 2,
        pourMl: 275,
        compCount: 1,
        compRate: 1 / 3,
      }),
      expect.objectContaining({
        memberId: "m-b",
        userId: "u-b",
        closeoutCount: 1,
        closeoutVarianceMl: -30,
      }),
    ]);
    expect(supabase.selects.pour_events[0]).toContain("actor_user_id");
    expect(supabase.selects.stock_adjustments[0]).toContain("acting_user_id");
    expect(supabase.selects.bottle_closeouts[0]).toContain("closed_by");
  });

  it("paginates each analytics read past the PostgREST page cap", async () => {
    const pours = Array.from({ length: 1_001 }, () => ({
      actor_user_id: "u-a",
      ml_delta: 1,
      kind: "pour",
    }));
    const supabase = makeSupabase({
      memberships: [{ id: "m-a", user_id: "u-a", role: "owner" }],
      pour_events: pours,
      stock_adjustments: [],
      bottle_closeouts: [],
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-a",
      user: { id: "u-a" },
      role: "owner",
    });

    const body = await (await GET()).json();

    expect(body.members[0]).toEqual(expect.objectContaining({
      pourCount: 1_001,
      pourMl: 1_001,
    }));
    expect(supabase.ranges.pour_events).toEqual([[0, 999], [1000, 1999]]);
  });
});
