import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { GET: PRICING_SUGGESTION } = await import(
  "./[id]/pricing-suggestion/route"
);
const { GET: PRICE_COMPARISON } = await import("./price-comparison/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

type DbPlan = {
  table: string;
  data?: unknown;
  error?: { message: string } | null;
};

function makeSupabase(dbPlans: DbPlan[]) {
  const calls: Array<{
    table: string;
    filters: Array<[string, unknown]>;
    ranges: Array<[number, number]>;
  }> = [];
  const from = vi.fn((table: string) => {
    const plan = dbPlans.shift();
    if (!plan) throw new Error(`Unexpected database call to ${table}`);
    if (plan.table !== table) {
      throw new Error(`Expected ${plan.table}, received ${table}`);
    }
    const call = {
      table,
      filters: [],
      ranges: [],
    } as {
      table: string;
      filters: Array<[string, unknown]>;
      ranges: Array<[number, number]>;
    };
    calls.push(call);
    const result = () => ({
      data: plan.data ?? null,
      error: plan.error ?? null,
    });
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      gt: (column: string, value: unknown) => {
        call.filters.push([column, [">", value]]);
        return chain;
      },
      or: (value: string) => {
        call.filters.push(["or", value]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      range: (fromIndex: number, toIndex: number) => {
        call.ranges.push([fromIndex, toIndex]);
        return chain;
      },
      maybeSingle: async () => result(),
      then: (
        resolve: (value: ReturnType<typeof result>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  });
  return { calls, client: { from }, from };
}

function authenticate(dbPlans: DbPlan[]) {
  const supabase = makeSupabase(dbPlans);
  auth.requireMembership.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
  return supabase;
}

function pricingRequest(query = "") {
  return new NextRequest(
    `http://localhost/api/wines/${WINE_ID}/pricing-suggestion${query}`,
  );
}

function wine(overrides: Record<string, unknown> = {}) {
  return {
    id: WINE_ID,
    varietal: "Pinot Noir",
    region: "Burgundy",
    rating: 94,
    retail_median: 100,
    retail_min: 80,
    retail_max: 120,
    retail_retailer_count: 7,
    retail_refreshed_at: "2026-07-24T12:00:00.000Z",
    pricing_target_pour_cost_pct: null,
    pricing_target_markup_ratio: null,
    size_ml: 750,
    ...overrides,
  };
}

async function callPricing(query = "") {
  return PRICING_SUGGESTION(pricingRequest(query), {
    params: Promise.resolve({ id: WINE_ID }),
  });
}

function inventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    unit_cost: 50,
    quantity: 2,
    currency: "USD",
    added_at: "2026-02-01T00:00:00.000Z",
    wines: {
      id: WINE_ID,
      name: "Reserve",
      producer: "Domaine Test",
      vintage: 2020,
      varietal: "Pinot Noir",
    },
    invoice_scans: {
      distributor_name: "Distributor A",
      invoice_date: "2026-02-01",
    },
    ...overrides,
  };
}

describe("wine read route behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes a missing pricing wine from a provider failure", async () => {
    const supabase = authenticate([{ table: "wines", data: null }]);

    const response = await callPricing();

    expect(response.status).toBe(404);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "restaurant defaults",
      plans: [
        { table: "wines", data: wine() },
        {
          table: "restaurants",
          error: { message: "restaurant provider failed" },
        },
      ],
    },
    {
      name: "invoice cost",
      plans: [
        { table: "wines", data: wine() },
        {
          table: "restaurants",
          data: {
            default_target_pour_cost_pct: null,
            default_target_markup_ratio: null,
          },
        },
        {
          table: "inventory_items",
          error: { message: "invoice provider failed" },
        },
      ],
    },
  ])("fails when $name cannot be read", async ({ plans }) => {
    authenticate(plans);

    const response = await callPricing();

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("uses only positive USD invoice costs and rounds glass pours", async () => {
    const supabase = authenticate([
      { table: "wines", data: wine() },
      {
        table: "restaurants",
        data: {
          default_target_pour_cost_pct: null,
          default_target_markup_ratio: null,
        },
      },
      {
        table: "inventory_items",
        data: { unit_cost: 50, currency: "USD", added_via: "invoice_scan" },
      },
    ]);

    const response = await callPricing("?glassPourMl=148.9");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      glassPourMl: 149,
      suggestedGlass: 45,
    });
    expect(supabase.calls[2].filters).toEqual(
      expect.arrayContaining([
        ["added_via", "invoice_scan"],
        ["unit_cost", [">", 0]],
        ["or", "currency.is.null,currency.eq.USD"],
      ]),
    );
  });

  it.each([
    { unit_cost: 0, currency: "USD" },
    { unit_cost: 50, currency: "EUR" },
  ])(
    "falls back to retail instead of treating $currency $unit_cost as USD invoice cost",
    async (invoice) => {
      authenticate([
        { table: "wines", data: wine() },
        {
          table: "restaurants",
          data: {
            default_target_pour_cost_pct: null,
            default_target_markup_ratio: null,
          },
        },
        {
          table: "inventory_items",
          data: { ...invoice, added_via: "invoice_scan" },
        },
      ]);

      const response = await callPricing();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        suggestedGlass: 90,
      });
    },
  );

  it("reports a category band only when it wins markup precedence", async () => {
    authenticate([
      {
        table: "wines",
        data: wine({ pricing_target_markup_ratio: 3.1 }),
      },
      {
        table: "restaurants",
        data: {
          default_target_pour_cost_pct: null,
          default_target_markup_ratio: 2.9,
        },
      },
      { table: "inventory_items", data: null },
    ]);

    const response = await callPricing();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      targetMarkupRatio: 3.1,
      categoryBandApplied: false,
    });
  });

  it("paginates comparison rows and keeps the latest USD price per distributor", async () => {
    const filler = Array.from({ length: 998 }, (_, index) =>
      inventoryRow({
        unit_cost: 50,
        currency: "EUR",
        added_at: `2025-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const oldPrice = inventoryRow({
      unit_cost: 100,
      added_at: "2026-01-01T00:00:00.000Z",
      invoice_scans: {
        distributor_name: "Distributor A",
        invoice_date: "2026-01-01",
      },
    });
    const latestPrice = inventoryRow({
      unit_cost: 80,
      added_at: "2026-02-01T00:00:00.000Z",
      invoice_scans: {
        distributor_name: "Distributor A",
        invoice_date: "2026-02-01",
      },
    });
    const otherDistributor = inventoryRow({
      unit_cost: 120,
      added_at: "2026-03-01T00:00:00.000Z",
      invoice_scans: {
        distributor_name: "Distributor B",
        invoice_date: "2026-03-01",
      },
    });
    const supabase = authenticate([
      {
        table: "inventory_items",
        data: [oldPrice, latestPrice, ...filler],
      },
      { table: "inventory_items", data: [otherDistributor] },
    ]);

    const response = await PRICE_COMPARISON();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        wine: oldPrice.wines,
        prices: [
          {
            distributor: "Distributor A",
            unitCost: 80,
            quantity: 2,
            invoiceDate: "2026-02-01",
          },
          {
            distributor: "Distributor B",
            unitCost: 120,
            quantity: 2,
            invoiceDate: "2026-03-01",
          },
        ],
        cheapest: 80,
        mostExpensive: 120,
        spread: 0.5,
        distributorCount: 2,
      },
    ]);
    expect(supabase.calls.map((call) => call.ranges)).toEqual([
      [[0, 999]],
      [[1000, 1999]],
    ]);
  });

  it("returns a redacted failure instead of a partial comparison page", async () => {
    authenticate([
      {
        table: "inventory_items",
        data: Array.from({ length: 1000 }, () => inventoryRow()),
      },
      {
        table: "inventory_items",
        error: { message: "second page failed" },
      },
    ]);

    const response = await PRICE_COMPARISON();

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });
});
