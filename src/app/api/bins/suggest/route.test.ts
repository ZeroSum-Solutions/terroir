import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
const mockCaptureException = vi.fn();
const mockSuggestPutAway = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock("@/lib/bins", () => ({
  suggestPutAway: (...args: unknown[]) => mockSuggestPutAway(...args),
}));

const { GET } = await import("./route");

type Result = { data: unknown; error: unknown };
type Operation = [string, ...unknown[]];

function makeSupabase(results: Record<string, Result>) {
  const operations: Record<string, Operation[]> = {};
  const from = vi.fn((table: string) => {
    const ops = (operations[table] ??= []);
    const result = results[table] ?? { data: null, error: null };
    const chain = {
      select: (...args: unknown[]) => (ops.push(["select", ...args]), chain),
      eq: (...args: unknown[]) => (ops.push(["eq", ...args]), chain),
      is: (...args: unknown[]) => (ops.push(["is", ...args]), chain),
      in: (...args: unknown[]) => (ops.push(["in", ...args]), chain),
      order: (...args: unknown[]) => (ops.push(["order", ...args]), chain),
      maybeSingle: async () => result,
      then: (resolve: (value: Result) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return chain;
  });
  return { from, operations };
}

function allowMember(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

const WINE_ID = "22222222-2222-4222-8222-222222222222";

function request(query = `wine_id=${WINE_ID}`): NextRequest {
  return new NextRequest(
    `http://localhost/api/bins/suggest${query ? `?${query}` : ""}`,
  );
}

describe("GET /api/bins/suggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([401, 403])(
    "returns an auth denial before validation or database access (%s)",
    async (status) => {
      const supabase = makeSupabase({});
      mockRequireMembership.mockResolvedValue(
        NextResponse.json({ error: "denied" }, { status }),
      );

      const response = await GET(request("wine_id=not-a-uuid"));

      expect(response.status).toBe(status);
      expect(supabase.from).not.toHaveBeenCalled();
      expect(mockSuggestPutAway).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", ""],
    ["empty", "wine_id="],
    ["malformed", "wine_id=not-a-uuid"],
    ["duplicate", `wine_id=${WINE_ID}&wine_id=${WINE_ID}`],
    ["unknown", `wine_id=${WINE_ID}&restaurant_id=restaurant-b`],
  ])("returns 400 for %s query input before database access", async (_name, query) => {
    const supabase = makeSupabase({});
    allowMember(supabase);

    const response = await GET(request(query));

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mockSuggestPutAway).not.toHaveBeenCalled();
  });

  it("returns 404 for a wine outside the explicit tenant scope", async () => {
    const supabase = makeSupabase({
      wines: { data: null, error: null },
    });
    allowMember(supabase);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(supabase.operations.wines).toContainEqual(["eq", "id", WINE_ID]);
    expect(supabase.operations.wines).toContainEqual([
      "eq",
      "restaurant_id",
      "restaurant-a",
    ]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("adapts active bins and nested wine inventory into a suggestion", async () => {
    const bins = [
      {
        id: "bin-a",
        code: "A-01",
        zone: "Reds",
        capacity: 12,
        retired_at: null,
      },
      {
        id: "bin-b",
        code: "B-02",
        zone: "Whites",
        capacity: 6,
        retired_at: null,
      },
    ];
    const supabase = makeSupabase({
      wines: {
        data: { id: WINE_ID, lineage_id: "lineage-a", colour: "red" },
        error: null,
      },
      bins: { data: bins, error: null },
      inventory_items: {
        data: [
          {
            wine_id: "wine-existing",
            bin_id: "bin-a",
            quantity: 3,
            bins: { code: "A-01", zone: "Reds" },
            wines: {
              lineage_id: "lineage-a",
              name: "Estate Red",
              producer: "Maker",
              colour: "red",
            },
          },
        ],
        error: null,
      },
    });
    allowMember(supabase);
    mockSuggestPutAway.mockReturnValue({
      binId: "bin-a",
      code: "A-01",
      zone: "Reds",
      reason: "same_lineage",
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bin_id: "bin-a",
      code: "A-01",
      zone: "Reds",
      reason: "same_lineage",
    });
    expect(mockSuggestPutAway).toHaveBeenCalledWith({
      wine: { lineageId: "lineage-a", colour: "red" },
      bins: [
        {
          id: "bin-a",
          code: "A-01",
          zone: "Reds",
          capacity: 12,
          retiredAt: null,
        },
        {
          id: "bin-b",
          code: "B-02",
          zone: "Whites",
          capacity: 6,
          retiredAt: null,
        },
      ],
      inventoryRows: [
        {
          wineId: "wine-existing",
          lineageId: "lineage-a",
          name: "Estate Red",
          producer: "Maker",
          colour: "red",
          binId: "bin-a",
          binCode: "A-01",
          binZone: "Reds",
          quantity: 3,
        },
      ],
    });
    expect(supabase.operations.bins).toContainEqual([
      "is",
      "retired_at",
      null,
    ]);
    expect(supabase.operations.inventory_items).toContainEqual([
      "eq",
      "restaurant_id",
      "restaurant-a",
    ]);
    expect(supabase.operations.inventory_items).toContainEqual([
      "in",
      "bin_id",
      ["bin-a", "bin-b"],
    ]);
  });

  it("passes capacity and occupancy data through and returns null", async () => {
    const supabase = makeSupabase({
      wines: {
        data: { id: WINE_ID, lineage_id: null, colour: "white" },
        error: null,
      },
      bins: {
        data: [
          {
            id: "bin-full",
            code: "W-01",
            zone: "Whites",
            capacity: 2,
            retired_at: null,
          },
        ],
        error: null,
      },
      inventory_items: {
        data: [
          {
            wine_id: "wine-existing",
            bin_id: "bin-full",
            quantity: 2,
            bins: { code: "W-01", zone: "Whites" },
            wines: {
              lineage_id: "lineage-b",
              name: "White",
              producer: "Maker",
              colour: "white",
            },
          },
        ],
        error: null,
      },
    });
    allowMember(supabase);
    mockSuggestPutAway.mockImplementation((input) =>
      input.bins[0].capacity === input.inventoryRows[0].quantity ? null : {},
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it.each([
    ["wine", "wines"],
    ["bin", "bins"],
    ["inventory", "inventory_items"],
  ])("redacts and captures a %s database failure", async (phase, table) => {
    const error = { code: "XX000", message: "password=secret" };
    const results: Record<string, Result> = {
      wines: {
        data: { id: WINE_ID, lineage_id: "lineage-a", colour: "red" },
        error: null,
      },
      bins: {
        data: [
          {
            id: "bin-a",
            code: "A-01",
            zone: null,
            capacity: null,
            retired_at: null,
          },
        ],
        error: null,
      },
      inventory_items: { data: [], error: null },
    };
    results[table] = { data: null, error };
    const supabase = makeSupabase(results);
    allowMember(supabase);

    const response = await GET(request());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(mockCaptureException).toHaveBeenCalledWith(
      new Error(`bin suggestion ${phase} failed`),
      {
      tags: { surface: "bins", phase: `suggest-${phase}` },
      extra: { restaurantId: "restaurant-a", wineId: WINE_ID },
      },
    );
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("secret");
    expect(console.error).toHaveBeenCalledWith(
      `bin suggestion ${phase} failed`,
    );
    expect(mockSuggestPutAway).not.toHaveBeenCalled();
  });
});
