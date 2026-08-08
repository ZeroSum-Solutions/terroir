import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { GET } = await import("./route");

type QueryResult = { data: unknown; error: unknown };

function makeSupabase(results: Record<string, QueryResult>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const result = results[table] ?? { data: [], error: null };
    const query = {
      select: (...args: unknown[]) => {
        calls.push({ table, method: "select", args });
        return query;
      },
      eq: (...args: unknown[]) => {
        calls.push({ table, method: "eq", args });
        return query;
      },
      order: (...args: unknown[]) => {
        calls.push({ table, method: "order", args });
        return query;
      },
      gte: (...args: unknown[]) => {
        calls.push({ table, method: "gte", args });
        return query;
      },
      lte: (...args: unknown[]) => {
        calls.push({ table, method: "lte", args });
        return query;
      },
      then: (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
  });
  return { from, calls };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("GET /api/insights/pour", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["pour_events", "inventory_items", "wine_list_items"])(
    "redacts a %s query failure instead of returning partial analytics",
    async (failedTable) => {
      const results = Object.fromEntries(
        ["pour_events", "inventory_items", "wine_list_items"].map((table) => [
          table,
          {
            data: [],
            error:
              table === failedTable
                ? { message: "super-secret analytics failure" }
                : null,
          },
        ]),
      );
      const supabase = makeSupabase(results);
      allow(supabase);

      const response = await GET(
        new NextRequest("http://localhost/api/insights/pour?range=30d"),
      );
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "internal_error",
          message: "Failed to load pour analytics.",
        },
      });
      expect(text).not.toContain("super-secret");
    },
  );

  it("rejects a one-sided custom range before querying tenant data", async () => {
    const supabase = makeSupabase({
      pour_events: { data: [], error: null },
      inventory_items: { data: [], error: null },
      wine_list_items: { data: [], error: null },
    });
    allow(supabase);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/insights/pour?range=custom&from=2026-01-02&topN=2",
      ),
    );

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("uses UTC custom boundaries, tenant filters, and the stable response shape", async () => {
    const supabase = makeSupabase({
      pour_events: { data: [], error: null },
      inventory_items: { data: [], error: null },
      wine_list_items: { data: [], error: null },
    });
    allow(supabase);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/insights/pour?range=custom&from=2026-01-02&to=2026-01-31&topN=2",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      range: "custom",
      topN: 2,
      totalPours: 0,
      pourVolumeBySection: [],
      topWinesByPours: [],
      topWinesByRevenue: [],
    });
    expect(supabase.calls).toContainEqual({
      table: "pour_events",
      method: "gte",
      args: ["occurred_at", "2026-01-02T00:00:00.000Z"],
    });
    expect(supabase.calls).toContainEqual({
      table: "pour_events",
      method: "lte",
      args: ["occurred_at", "2026-01-31T23:59:59.999Z"],
    });
    expect(
      supabase.calls.filter(
        (call) =>
          call.method === "eq" && call.args.includes("restaurant-a"),
      ),
    ).toHaveLength(3);
  });

  it("calculates non-empty section volume, top-N pours, and price times pour count", async () => {
    const wine = (id: string, name: string) => ({
      id,
      name,
      producer: `${name} Producer`,
      vintage: 2020,
    });
    const event = (
      wineId: string,
      name: string,
      ml: number,
      kind = "pour",
    ) => ({
      wine_id: wineId,
      ml_delta: ml,
      kind,
      occurred_at: "2026-01-15T00:00:00.000Z",
      wines: wine(wineId, name),
    });
    const listItem = (wineId: string, glassPrice: number, pourMl: number) => ({
      wine_id: wineId,
      glass_price: glassPrice,
      glass_pour_ml: pourMl,
      updated_at: "2026-01-01T00:00:00.000Z",
      wine_list_sections: {
        wine_lists: { id: "list-a", restaurant_id: "restaurant-a" },
      },
    });
    const supabase = makeSupabase({
      pour_events: {
        data: [
          event("wine-a", "Alpha", 75),
          event("wine-a", "Alpha", 150),
          event("wine-a", "Alpha", 50),
          event("wine-b", "Bravo", 100),
          event("wine-b", "Bravo", 100),
          event("wine-c", "Charlie", 150),
          event("wine-c", "Charlie", -150, "undo"),
        ],
        error: null,
      },
      inventory_items: {
        data: [
          { wine_id: "wine-a", section: "Red" },
          { wine_id: "wine-b", section: "White" },
          { wine_id: "wine-c", section: "Red" },
        ],
        error: null,
      },
      wine_list_items: {
        data: [
          listItem("wine-a", 12, 150),
          listItem("wine-b", 20, 100),
          listItem("wine-c", 8, 150),
        ],
        error: null,
      },
    });
    allow(supabase);

    const response = await GET(
      new NextRequest("http://localhost/api/insights/pour?range=all&topN=2"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      range: "all",
      topN: 2,
      totalPours: 6,
      pourVolumeBySection: [
        { section: "Red", oz: 14.4 },
        { section: "White", oz: 6.8 },
      ],
      topWinesByPours: [
        {
          wine_id: "wine-a",
          name: "Alpha",
          producer: "Alpha Producer",
          vintage: 2020,
          pour_count: 3,
        },
        {
          wine_id: "wine-b",
          name: "Bravo",
          producer: "Bravo Producer",
          vintage: 2020,
          pour_count: 2,
        },
      ],
      topWinesByRevenue: [
        {
          wine_id: "wine-b",
          name: "Bravo",
          producer: "Bravo Producer",
          vintage: 2020,
          revenue: 40,
          pour_count: 2,
        },
        {
          wine_id: "wine-a",
          name: "Alpha",
          producer: "Alpha Producer",
          vintage: 2020,
          revenue: 36,
          pour_count: 3,
        },
      ],
    });
  });
});
