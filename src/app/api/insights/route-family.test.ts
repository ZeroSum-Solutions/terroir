import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
const mockCaptureException = vi.fn();
const mockFetchDrinkWindowAlerts = vi.fn();
const mockFetchPricingAlerts = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock("@/lib/drink-window/alerts", () => ({
  fetchDrinkWindowAlerts: (...args: unknown[]) =>
    mockFetchDrinkWindowAlerts(...args),
}));
vi.mock("@/lib/pricing/alerts", () => ({
  fetchPricingAlerts: (...args: unknown[]) => mockFetchPricingAlerts(...args),
}));

const { GET: getInsights } = await import("./route");
const { GET: getInsightsCsv } = await import("./csv/route");
const { GET: getDrinkWindowAlerts } =
  await import("./drink-window-alerts/route");
const { GET: getPricingReview } = await import("./pricing-review/route");
const { GET: getSnoozed } = await import("./snoozed/route");
const { GET: getToastCsv } = await import("../export/toast-csv/route");

type QueryResult = {
  data: unknown;
  error: unknown;
};

type QueryCall = {
  table: string;
  method: string;
  args: unknown[];
};

function makeSupabase(
  results: Record<string, QueryResult | QueryResult[]> = {},
) {
  const calls: QueryCall[] = [];
  const queues = new Map(
    Object.entries(results).map(([table, result]) => [
      table,
      Array.isArray(result) ? [...result] : [result],
    ]),
  );
  const from = vi.fn((table: string) => {
    const result = queues.get(table)?.shift() ?? { data: [], error: null };
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
      or: (...args: unknown[]) => {
        calls.push({ table, method: "or", args });
        return query;
      },
      in: (...args: unknown[]) => {
        calls.push({ table, method: "in", args });
        return query;
      },
      then: (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    calls.push({ table, method: "from", args: [] });
    return query;
  });
  return { from, calls };
}

function allow(supabase = makeSupabase()) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
  return supabase;
}

async function expectNested500(
  response: Response,
  message = "Internal server error.",
) {
  const text = await response.text();
  expect(response.status).toBe(500);
  expect(JSON.parse(text)).toEqual({
    error: { code: "internal_error", message },
  });
  expect(text).not.toContain("super-secret");
}

const routes = [
  { name: "insights", invoke: getInsights },
  { name: "insights CSV", invoke: getInsightsCsv },
  { name: "drink-window alerts", invoke: getDrinkWindowAlerts },
  { name: "pricing review", invoke: getPricingReview },
  { name: "snoozed alerts", invoke: getSnoozed },
  { name: "Toast CSV", invoke: getToastCsv },
] as const;

describe("insights and Toast route-family boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(routes)(
    "redacts an unexpected auth failure for $name",
    async ({ invoke }) => {
      mockRequireMembership.mockRejectedValue(
        new Error("super-secret auth failure"),
      );

      const response = await invoke();

      await expectNested500(response);
      expect(mockFetchDrinkWindowAlerts).not.toHaveBeenCalled();
      expect(mockFetchPricingAlerts).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "preserves auth-response identity before work for $name",
    async ({ invoke }) => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      mockRequireMembership.mockResolvedValue(denial);

      const response = await invoke();

      expect(response).toBe(denial);
      expect(mockFetchDrinkWindowAlerts).not.toHaveBeenCalled();
      expect(mockFetchPricingAlerts).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/insights", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["invoice_scans", "inventory_items"])(
    "does not turn a %s query error into empty metrics",
    async (failedTable) => {
      const error = { message: "super-secret query failure" };
      allow(
        makeSupabase({
          invoice_scans: {
            data: [],
            error: failedTable === "invoice_scans" ? error : null,
          },
          inventory_items: {
            data: [],
            error: failedTable === "inventory_items" ? error : null,
          },
        }),
      );

      await expectNested500(
        await getInsights(),
        "Failed to load insights data.",
      );
    },
  );

  it("preserves staff access, tenant predicates, and response fields", async () => {
    const createdAt = new Date().toISOString();
    const supabase = allow(
      makeSupabase({
        invoice_scans: {
          data: [
            {
              id: "scan-a",
              distributor_name: "Acme",
              item_count: 2,
              accuracy_score: 0.9,
              edits: { "item-a:name": true, "item-a:producer": true },
              created_at: createdAt,
            },
          ],
          error: null,
        },
        inventory_items: {
          data: [
            {
              quantity: 2,
              unit_cost: 30,
              wine_id: "wine-a",
              wines: { varietal: "Cabernet" },
            },
          ],
          error: null,
        },
      }),
    );

    const response = await getInsights();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inventoryValue: 60,
      totalBottles: 2,
      scanCount: 1,
      totalScans: 1,
      avgAccuracy: 0.5,
      varietalBreakdown: [{ name: "Cabernet", value: 60 }],
      recentScans: [
        {
          id: "scan-a",
          distributor_name: "Acme",
          item_count: 2,
          accuracy_score: 0.9,
          created_at: createdAt,
        },
      ],
    });
    expect(
      supabase.calls.filter(
        (call) =>
          call.method === "eq" &&
          call.args[0] === "restaurant_id" &&
          call.args[1] === "restaurant-a",
      ),
    ).toHaveLength(2);
  });
});

describe("GET /api/insights/csv", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { table: "invoice_scans", occurrence: 0 },
    { table: "inventory_items", occurrence: 0 },
    { table: "inventory_items", occurrence: 1 },
  ])(
    "does not turn $table query occurrence $occurrence into an empty export",
    async ({ table, occurrence }) => {
      const error = { message: "super-secret CSV query failure" };
      const inventoryResults: QueryResult[] = [
        { data: [], error: null },
        { data: [], error: null },
      ];
      if (table === "inventory_items") {
        inventoryResults[occurrence] = { data: [], error };
      }
      allow(
        makeSupabase({
          invoice_scans: {
            data: [],
            error: table === "invoice_scans" ? error : null,
          },
          inventory_items: inventoryResults,
        }),
      );

      await expectNested500(
        await getInsightsCsv(),
        "Failed to generate CSV export.",
      );
    },
  );

  it("rejects a malformed custom range before querying tenant data", async () => {
    const supabase = allow();

    const response = await getInsightsCsv(
      new Request(
        "http://localhost/api/insights/csv?range=custom&from=2026-02-31&to=2026-01-01",
      ),
    );

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects an unknown range before querying tenant data", async () => {
    const supabase = allow();

    const response = await getInsightsCsv(
      new Request("http://localhost/api/insights/csv?range=everything"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error", message: "Invalid input." },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("exports the selected custom range and line-item correction accuracy", async () => {
    const supabase = allow(
      makeSupabase({
        invoice_scans: {
          data: [
            {
              id: "scan-a",
              distributor_name: "=2+2",
              item_count: 2,
              accuracy_score: 0.9,
              edits: { "item-a:name": true, "item-a:producer": true },
              created_at: "2026-01-02T00:00:00.000Z",
              final_line_items: [{ qty: 2, unitCost: 10 }],
            },
          ],
          error: null,
        },
        inventory_items: [
          {
            data: [
              {
                quantity: 2,
                unit_cost: 15,
                wine_id: "wine-a",
                wines: { varietal: "@SUM(A1:A2)" },
              },
            ],
            error: null,
          },
          {
            data: [
              {
                quantity: 2,
                unit_cost: 15,
                invoice_scan_id: "scan-a",
                invoice_scans: { distributor_name: "=2+2" },
              },
            ],
            error: null,
          },
        ],
      }),
    );

    const response = await getInsightsCsv(
      new Request(
        "http://localhost/api/insights/csv?range=custom&from=2026-01-01&to=2026-01-31",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="insights-export.csv"',
    );
    expect(await response.text()).toBe(
      [
        "=== SCAN ACTIVITY ===",
        "Date,Distributor,Items Scanned,Auto-Accepted Items,Corrected Items,Accuracy,Value",
        "2026-01-02,'=2+2,2,1,1,50%,$20",
        "",
        "=== DISTRIBUTOR BREAKDOWN ===",
        "Distributor,Scans,Spend,Share",
        "'=2+2,1,$30,100%",
        "",
        "=== VARIETAL BREAKDOWN ===",
        "Varietal,Value,Share",
        "'@SUM(A1:A2),$30,100%",
      ].join("\n"),
    );
    expect(
      supabase.calls.filter(
        (call) =>
          call.method === "eq" &&
          call.args[0] === "restaurant_id" &&
          call.args[1] === "restaurant-a",
      ),
    ).toHaveLength(3);
    expect(supabase.calls).toContainEqual({
      table: "invoice_scans",
      method: "gte",
      args: ["created_at", "2026-01-01T00:00:00.000Z"],
    });
    expect(supabase.calls).toContainEqual({
      table: "invoice_scans",
      method: "lte",
      args: ["created_at", "2026-01-31T23:59:59.999Z"],
    });
    expect(supabase.calls).toContainEqual({
      table: "inventory_items",
      method: "gte",
      args: ["invoice_scans.created_at", "2026-01-01T00:00:00.000Z"],
    });
    expect(supabase.calls).toContainEqual({
      table: "inventory_items",
      method: "lte",
      args: ["invoice_scans.created_at", "2026-01-31T23:59:59.999Z"],
    });
  });
});

describe("alert insight routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      name: "drink-window",
      invoke: getDrinkWindowAlerts,
      helper: mockFetchDrinkWindowAlerts,
      message: "Failed to fetch alerts.",
    },
    {
      name: "pricing",
      invoke: getPricingReview,
      helper: mockFetchPricingAlerts,
      message: "Failed to fetch pricing alerts.",
    },
  ])(
    "redacts $name helper failures and preserves helper arguments",
    async ({ invoke, helper, message }) => {
      const supabase = allow();
      helper.mockRejectedValue(new Error("super-secret helper failure"));

      await expectNested500(await invoke(), message);
      expect(helper).toHaveBeenCalledWith(supabase, "restaurant-a");
    },
  );

  it.each([
    {
      name: "drink-window",
      invoke: getDrinkWindowAlerts,
      helper: mockFetchDrinkWindowAlerts,
      envelope: "alerts",
    },
    {
      name: "pricing",
      invoke: getPricingReview,
      helper: mockFetchPricingAlerts,
      envelope: "alerts",
    },
  ])(
    "preserves the $name success envelope",
    async ({ invoke, helper, envelope }) => {
      const supabase = allow();
      const alerts = [{ wine_id: "wine-a" }];
      helper.mockResolvedValue(alerts);

      const response = await invoke();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ [envelope]: alerts });
      expect(helper).toHaveBeenCalledWith(supabase, "restaurant-a");
    },
  );
});

describe("GET /api/insights/snoozed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a nested redacted database failure", async () => {
    allow(
      makeSupabase({
        wines: {
          data: null,
          error: { message: "super-secret snoozed failure" },
        },
      }),
    );

    await expectNested500(
      await getSnoozed(),
      "Failed to fetch snoozed alerts.",
    );
  });

  it("preserves active-only ordering and the snoozed envelope", async () => {
    const supabase = allow(
      makeSupabase({
        wines: {
          data: [
            {
              id: "wine-later",
              name: "Later",
              producer: "Beta",
              vintage: 2020,
              alert_snoozed_until: "2999-02-01T00:00:00.000Z",
              pricing_dismissed_until: null,
            },
            {
              id: "wine-sooner",
              name: "Sooner",
              producer: "Alpha",
              vintage: null,
              alert_snoozed_until: null,
              pricing_dismissed_until: "2999-01-01T00:00:00.000Z",
            },
          ],
          error: null,
        },
      }),
    );

    const response = await getSnoozed();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      snoozed: [
        {
          wine_id: "wine-sooner",
          name: "Sooner",
          producer: "Alpha",
          vintage: null,
          drinkWindowSnoozedUntil: null,
          pricingDismissedUntil: "2999-01-01T00:00:00.000Z",
        },
        {
          wine_id: "wine-later",
          name: "Later",
          producer: "Beta",
          vintage: 2020,
          drinkWindowSnoozedUntil: "2999-02-01T00:00:00.000Z",
          pricingDismissedUntil: null,
        },
      ],
    });
    expect(supabase.calls).toContainEqual({
      table: "wines",
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
  });
});

describe("GET /api/export/toast-csv", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["wines", "wine_list_items"])(
    "does not turn a %s query error into a CSV",
    async (failedTable) => {
      const error = { message: "super-secret Toast query failure" };
      allow(
        makeSupabase({
          wines: {
            data: [
              {
                id: "wine-a",
                name: "Reserve",
                producer: "Acme",
                vintage: 2020,
                varietal: "Cabernet",
              },
            ],
            error: failedTable === "wines" ? error : null,
          },
          wine_list_items: {
            data: [],
            error: failedTable === "wine_list_items" ? error : null,
          },
        }),
      );

      await expectNested500(await getToastCsv());
    },
  );

  it("preserves Toast content, filename, tenant scope, and price lookup", async () => {
    const supabase = allow(
      makeSupabase({
        wines: {
          data: [
            {
              id: "wine-a",
              name: "Reserve",
              producer: "Acme",
              vintage: 2020,
              varietal: "Cabernet",
            },
          ],
          error: null,
        },
        wine_list_items: {
          data: [
            { wine_id: "wine-a", bottle_price: 75 },
            { wine_id: "wine-a", bottle_price: 80 },
          ],
          error: null,
        },
      }),
    );

    const response = await getToastCsv();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="toast-import.csv"',
    );
    expect(await response.text()).toBe(
      [
        "Name,Menu Group,Menu Subgroup,Price,POS Name,SKU,Item Type",
        "Acme Reserve 2020,Wine,Cabernet,80.00,Reserve 2020,,Item",
      ].join("\n"),
    );
    expect(supabase.calls).toContainEqual({
      table: "wines",
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
    expect(supabase.calls).toContainEqual({
      table: "wine_list_items",
      method: "in",
      args: ["wine_id", ["wine-a"]],
    });
  });
});
