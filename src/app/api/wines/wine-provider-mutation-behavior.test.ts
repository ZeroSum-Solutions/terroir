import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
const providers = vi.hoisted(() => ({
  enrichWine: vi.fn(),
  enrichWineWithClaude: vi.fn(),
  fetchRetailPrices: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireMembership(...args),
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
}));
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: (...args: unknown[]) => providers.enrichWine(...args),
}));
vi.mock("@/lib/wine-intelligence/enrich-claude", () => ({
  enrichWineWithClaude: (...args: unknown[]) =>
    providers.enrichWineWithClaude(...args),
}));
vi.mock("@/lib/wine-intelligence/wine-searcher", () => ({
  fetchRetailPrices: (...args: unknown[]) =>
    providers.fetchRetailPrices(...args),
}));

const { POST: ENRICH_ONE } = await import("./[id]/enrich/route");
const { POST: REFRESH_ONE } = await import("./[id]/refresh-retail/route");
const { POST: CREATE_LWIN } = await import("./create-from-lwin/route");
const { POST: REFRESH_BATCH } = await import("./refresh-retail-batch/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

type DbPlan = {
  table: string;
  data?: unknown;
  error?: { message: string } | null;
};
type RpcPlan = {
  fn: string;
  data?: unknown;
  error?: { message: string } | null;
};
type DbCall = {
  table: string;
  action: "query" | "update";
  payload?: unknown;
  filters: Array<[string, unknown]>;
};

function makeSupabase(dbPlans: DbPlan[], rpcPlans: RpcPlan[] = []) {
  const calls: DbCall[] = [];
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    const plan = rpcPlans.shift();
    if (!plan) throw new Error(`Unexpected RPC ${fn}`);
    if (plan.fn !== fn) {
      throw new Error(`Expected RPC ${plan.fn}, received ${fn}`);
    }
    return { data: plan.data ?? null, error: plan.error ?? null, args };
  });
  const from = vi.fn((table: string) => {
    const plan = dbPlans.shift();
    if (!plan) throw new Error(`Unexpected database call to ${table}`);
    if (plan.table !== table) {
      throw new Error(`Expected ${plan.table}, received ${table}`);
    }
    const call: DbCall = {
      table,
      action: "query",
      filters: [],
    };
    calls.push(call);
    const result = () => ({
      data: plan.data ?? null,
      error: plan.error ?? null,
    });
    const chain = {
      select: () => chain,
      update: (payload: unknown) => {
        call.action = "update";
        call.payload = payload;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      in: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      gt: (column: string, value: unknown) => {
        call.filters.push([column, [">", value]]);
        return chain;
      },
      not: (column: string, operator: string, value: unknown) => {
        call.filters.push([column, [operator, value]]);
        return chain;
      },
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => result(),
      then: (
        resolve: (value: ReturnType<typeof result>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  });
  return { calls, client: { from, rpc }, rpc };
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authenticate(dbPlans: DbPlan[], rpcPlans: RpcPlan[] = []) {
  const supabase = makeSupabase(dbPlans, rpcPlans);
  auth.requireMembership.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
  return supabase;
}

const RULE_MISS = {
  drinkWindowStart: null,
  drinkWindowEnd: null,
  peakYear: null,
  ratingSource: null,
  reviewExcerpt: null,
  servingTempMin: null,
  servingTempMax: null,
  servingTempLabel: null,
  decantMinutes: null,
};

describe("wine provider mutation behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers.enrichWine.mockReset();
    providers.enrichWineWithClaude.mockReset();
    providers.fetchRetailPrices.mockReset();
    providers.enrichWineWithClaude.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("persists Claude decant guidance during single-wine enrichment", async () => {
    const supabase = authenticate(
      [
        {
          table: "wines",
          data: {
            id: WINE_ID,
            producer: "Domaine Test",
            name: "Reserve",
            varietal: "Unknown",
            region: "Unknown",
            country: null,
            vintage: 2018,
            lwin_id: null,
            manual_overrides: [],
          },
        },
      ],
      [{ fn: "enrich_wines_batch", data: 1 }],
    );
    providers.enrichWine.mockReturnValue(RULE_MISS);
    providers.enrichWineWithClaude.mockResolvedValue({
      drinkWindowStart: 2024,
      drinkWindowEnd: 2034,
      peakYear: 2029,
      ratingSource: "claude_inference",
      reviewExcerpt: "Structured and age-worthy.",
      servingTempMin: null,
      servingTempMax: null,
      servingTempLabel: null,
      decantMinutes: 45,
    });

    const response = await ENRICH_ONE(
      {} as Request,
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    const enrichCall = supabase.rpc.mock.calls.find(
      ([fn]) => fn === "enrich_wines_batch",
    );
    const args = enrichCall?.[1] as {
      p_enrichments: Array<Record<string, unknown>>;
    };
    expect(args.p_enrichments[0].decant_minutes).toBe(45);
    expect(
      (
        args.p_enrichments[0].enrichment_metadata as {
          fields_enriched: string[];
        }
      ).fields_enriched,
    ).toContain("decant");
  });

  it("does not report single enrichment success when the RPC updates zero rows", async () => {
    authenticate(
      [
        {
          table: "wines",
          data: {
            id: WINE_ID,
            producer: "Domaine Test",
            name: "Reserve",
            varietal: "Pinot Noir",
            region: "Burgundy",
            country: "France",
            vintage: 2018,
            lwin_id: null,
            manual_overrides: [],
          },
        },
      ],
      [{ fn: "enrich_wines_batch", data: 0 }],
    );
    providers.enrichWine.mockReturnValue({
      ...RULE_MISS,
      drinkWindowStart: 2020,
      drinkWindowEnd: 2030,
      ratingSource: "rule_engine",
    });

    const response = await ENRICH_ONE(
      {} as Request,
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(404);
  });

  it("distinguishes an enrichment lookup failure from a missing wine", async () => {
    authenticate([
      {
        table: "wines",
        error: { message: "provider unavailable" },
      },
    ]);

    const response = await ENRICH_ONE(
      {} as Request,
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("does not call retail pricing after the invoice lookup fails", async () => {
    authenticate([
      { table: "wines", data: { id: WINE_ID, lwin_id: "1000001" } },
      {
        table: "inventory_items",
        error: { message: "invoice provider unavailable" },
      },
    ]);

    const response = await REFRESH_ONE(
      {} as Request,
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
    expect(providers.fetchRetailPrices).not.toHaveBeenCalled();
  });

  it("does not pass a non-USD invoice cost into retail-price sanity checks", async () => {
    authenticate([
      { table: "wines", data: { id: WINE_ID, lwin_id: "1000001" } },
      {
        table: "inventory_items",
        data: {
          unit_cost: 75,
          currency: "EUR",
          added_via: "invoice_scan",
        },
      },
      { table: "wines", data: { id: WINE_ID } },
    ]);
    providers.fetchRetailPrices.mockResolvedValue({
      retailMin: 100,
      retailMax: 140,
      retailMedian: 120,
      retailerCount: 6,
      refreshedAt: new Date("2026-07-24T12:00:00.000Z"),
    });

    const response = await REFRESH_ONE(
      {} as Request,
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(providers.fetchRetailPrices).toHaveBeenCalledWith({
      lwinId: "1000001",
      invoiceCost: null,
    });
  });

  it("does not report retail refresh success when persistence affects no row", async () => {
    authenticate([
      { table: "wines", data: { id: WINE_ID, lwin_id: "1000001" } },
      { table: "inventory_items", data: { unit_cost: 75 } },
      { table: "wines", data: null },
    ]);
    providers.fetchRetailPrices.mockResolvedValue({
      retailMin: 100,
      retailMax: 140,
      retailMedian: 120,
      retailerCount: 6,
      refreshedAt: new Date("2026-07-24T12:00:00.000Z"),
    });

    const response = await REFRESH_ONE(
      {} as Request,
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(404);
  });

  it("uses canonical catalog metadata instead of client-provided LWIN fields", async () => {
    const supabase = authenticate(
      [
        {
          table: "lwin_catalog",
          data: {
            lwin_id: "1000001",
            display_name: "Canonical Wine",
            producer: "Canonical Producer",
            varietal: "Pinot Noir",
            region: "Burgundy",
            country: "France",
          },
        },
        { table: "wines", data: { id: WINE_ID } },
      ],
      [{ fn: "find_or_create_wines_batch", data: [WINE_ID] }],
    );

    const response = await CREATE_LWIN(
      request("/api/wines/create-from-lwin", {
        lwin_id: "1000001",
        display_name: "Attacker Name",
        producer: "Attacker Producer",
        varietal: null,
        region: null,
        country: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "find_or_create_wines_batch",
      expect.objectContaining({
        p_wines: [
          expect.objectContaining({
            name: "Canonical Wine",
            producer: "Canonical Producer",
            region: "Burgundy",
          }),
        ],
      }),
    );
  });

  it("returns 404 when the requested LWIN entry is absent", async () => {
    authenticate([{ table: "lwin_catalog", data: null }]);

    const response = await CREATE_LWIN(
      request("/api/wines/create-from-lwin", {
        lwin_id: "1000001",
        display_name: "Unknown",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a malformed wine ID returned by the find-or-create RPC", async () => {
    authenticate(
      [
        {
          table: "lwin_catalog",
          data: {
            lwin_id: "1000001",
            display_name: "Canonical Wine",
            producer: "Producer",
            varietal: null,
            region: null,
            country: null,
          },
        },
      ],
      [{ fn: "find_or_create_wines_batch", data: ["not-a-uuid"] }],
    );

    const response = await CREATE_LWIN(
      request("/api/wines/create-from-lwin", {
        lwin_id: "1000001",
        display_name: "Canonical Wine",
      }),
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("does not report create-from-LWIN success when persistence affects no row", async () => {
    authenticate(
      [
        {
          table: "lwin_catalog",
          data: {
            lwin_id: "1000001",
            display_name: "Canonical Wine",
            producer: "Producer",
            varietal: null,
            region: null,
            country: null,
          },
        },
        { table: "wines", data: null },
      ],
      [{ fn: "find_or_create_wines_batch", data: [WINE_ID] }],
    );

    const response = await CREATE_LWIN(
      request("/api/wines/create-from-lwin", {
        lwin_id: "1000001",
        display_name: "Canonical Wine",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("fails batch retail refresh before provider calls when invoice lookup fails", async () => {
    vi.stubEnv("WINE_SEARCHER_API_KEY", "configured-for-test");
    authenticate([
      {
        table: "wines",
        data: [
          {
            id: WINE_ID,
            lwin_id: "1000001",
            retail_refreshed_at: null,
          },
        ],
      },
      {
        table: "inventory_items",
        error: { message: "invoice lookup failed" },
      },
    ]);

    const response = await REFRESH_BATCH();

    expect(response.status).toBe(500);
    expect(providers.fetchRetailPrices).not.toHaveBeenCalled();
  });

  it("counts batch retail refreshes only after successful persistence", async () => {
    vi.stubEnv("WINE_SEARCHER_API_KEY", "configured-for-test");
    const secondWineId = "33333333-3333-4333-8333-333333333333";
    authenticate([
      {
        table: "wines",
        data: [
          {
            id: WINE_ID,
            lwin_id: "1000001",
            retail_refreshed_at: null,
          },
          {
            id: secondWineId,
            lwin_id: "1000002",
            retail_refreshed_at: null,
          },
        ],
      },
      {
        table: "inventory_items",
        data: [
          {
            wine_id: WINE_ID,
            unit_cost: 75,
            currency: "USD",
            added_via: "invoice_scan",
          },
        ],
      },
      { table: "wines", data: { id: WINE_ID } },
    ]);
    providers.fetchRetailPrices
      .mockResolvedValueOnce({
        retailMin: 100,
        retailMax: 140,
        retailMedian: 120,
        retailerCount: 6,
        refreshedAt: new Date("2026-07-24T12:00:00.000Z"),
      })
      .mockResolvedValueOnce(null);

    const response = await REFRESH_BATCH();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      refreshed: 1,
      skipped: 1,
      hasMore: false,
      apiKeyConfigured: true,
    });
  });

  it("stops batch retries when a full page cannot persist any progress", async () => {
    vi.stubEnv("WINE_SEARCHER_API_KEY", "configured-for-test");
    const wines = Array.from({ length: 50 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      lwin_id: `lwin-${index + 1}`,
      retail_refreshed_at: null,
    }));
    authenticate([
      { table: "wines", data: wines },
      { table: "inventory_items", data: [] },
      ...wines.map(() => ({ table: "wines", data: null })),
    ]);
    providers.fetchRetailPrices.mockResolvedValue({
      retailMin: 100,
      retailMax: 140,
      retailMedian: 120,
      retailerCount: 6,
      refreshedAt: new Date("2026-07-24T12:00:00.000Z"),
    });

    const response = await REFRESH_BATCH();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 50,
      refreshed: 0,
      skipped: 50,
      hasMore: false,
    });
  });
});
