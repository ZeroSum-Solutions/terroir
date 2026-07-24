import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { GET: PRICING_SUGGESTION } = await import(
  "./[id]/pricing-suggestion/route"
);
const { GET: AVAILABILITY } = await import("./availability/route");
const { GET: LWIN_SEARCH } = await import("./lwin-search/route");
const { GET: PRICE_COMPARISON } = await import("./price-comparison/route");
const { GET: SEARCH } = await import("./search/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

type DbPlan = {
  table: string;
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};

function makeSupabase(
  dbPlans: DbPlan[],
  rpcResult: { data?: unknown; error?: { message: string } | null } = {},
) {
  const calls: Array<{
    table: string;
    filters: Array<[string, unknown]>;
    orFilters: string[];
  }> = [];
  const from = vi.fn((table: string) => {
    const plan = dbPlans.shift();
    if (!plan) throw new Error(`Unexpected database call to ${table}`);
    if (plan.table !== table) {
      throw new Error(`Expected ${plan.table}, received ${table}`);
    }
    const call = { table, filters: [], orFilters: [] } as {
      table: string;
      filters: Array<[string, unknown]>;
      orFilters: string[];
    };
    calls.push(call);
    const result = () => ({
      data: plan.data ?? null,
      error: plan.error ?? null,
      count: plan.count ?? null,
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
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      or: (filter: string) => {
        call.orFilters.push(filter);
        return chain;
      },
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (
        resolve: (value: ReturnType<typeof result>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  });
  const rpc = vi.fn(async () => ({
    data: rpcResult.data ?? null,
    error: rpcResult.error ?? null,
  }));
  return { calls, client: { from, rpc }, from, rpc };
}

function authenticate(
  dbPlans: DbPlan[],
  rpcResult?: { data?: unknown; error?: { message: string } | null },
) {
  const supabase = makeSupabase(dbPlans, rpcResult);
  auth.requireMembership.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
  return supabase;
}

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

function watchedParams(id = WINE_ID) {
  let touches = 0;
  const params = {
    then(resolve: (value: { id: string }) => void) {
      touches += 1;
      resolve({ id });
    },
  } as unknown as Promise<{ id: string }>;
  return { params, touches: () => touches };
}

describe("wine read route boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates pricing suggestions before resolving path params", async () => {
    const denial = NextResponse.json(
      { error: { code: "unauthorized", message: "Unauthorized" } },
      { status: 401 },
    );
    auth.requireMembership.mockResolvedValue(denial);
    const watched = watchedParams();

    const response = await PRICING_SUGGESTION(
      request(`/api/wines/${WINE_ID}/pricing-suggestion`),
      { params: watched.params },
    );

    expect(response).toBe(denial);
    expect(watched.touches()).toBe(0);
  });

  it("rejects an invalid pricing-suggestion UUID before database work", async () => {
    const supabase = authenticate([]);

    const response = await PRICING_SUGGESTION(
      request("/api/wines/not-a-uuid/pricing-suggestion"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "pricing suggestion",
      call: () =>
        PRICING_SUGGESTION(
          request(
            `/api/wines/${WINE_ID}/pricing-suggestion?glassPourMl=100&glassPourMl=200`,
          ),
          { params: Promise.resolve({ id: WINE_ID }) },
        ),
    },
    {
      name: "availability",
      call: () =>
        AVAILABILITY(
          request("/api/wines/availability?limit=10&limit=20"),
        ),
    },
    {
      name: "LWIN search",
      call: () =>
        LWIN_SEARCH(request("/api/wines/lwin-search?q=ab&q=cd")),
    },
    {
      name: "wine search",
      call: () => SEARCH(request("/api/wines/search?q=ab&q=cd")),
    },
  ])("$name rejects duplicate scalar query parameters", async ({ call }) => {
    const supabase = authenticate([]);

    const response = await call();

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "pricing suggestion",
      setup: () => authenticate([
        { table: "wines", error: { message: "wine provider failed" } },
      ]),
      call: () =>
        PRICING_SUGGESTION(
          request(`/api/wines/${WINE_ID}/pricing-suggestion`),
          { params: Promise.resolve({ id: WINE_ID }) },
        ),
    },
    {
      name: "availability",
      setup: () =>
        authenticate([
          { table: "wines", error: { message: "availability failed" } },
        ]),
      call: () => AVAILABILITY(request("/api/wines/availability")),
    },
    {
      name: "LWIN search",
      setup: () =>
        authenticate([], { error: { message: "LWIN provider failed" } }),
      call: () => LWIN_SEARCH(request("/api/wines/lwin-search?q=wine")),
    },
    {
      name: "price comparison",
      setup: () =>
        authenticate([
          { table: "inventory_items", error: { message: "prices failed" } },
        ]),
      call: () => PRICE_COMPARISON(),
    },
    {
      name: "wine search",
      setup: () =>
        authenticate([
          { table: "wines", error: { message: "search failed" } },
        ]),
      call: () => SEARCH(request("/api/wines/search?q=wine")),
    },
  ])("$name redacts provider failures in the nested envelope", async ({
    setup,
    call,
  }) => {
    setup();

    const response = await call();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });

  it("quotes raw wine search text before building a PostgREST OR filter", async () => {
    const supabase = authenticate([{ table: "wines", data: [] }]);

    const response = await SEARCH(
      request('/api/wines/search?q=ACME%2Cname.eq.secret%22'),
    );

    expect(response.status).toBe(200);
    expect(supabase.calls[0].orFilters[0]).toBe(
      'name.ilike."%ACME,name.eq.secret\\"%",producer.ilike."%ACME,name.eq.secret\\"%"',
    );
  });
});
