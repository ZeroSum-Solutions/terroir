import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireCapability: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) => auth.requireCapability(...args),
  requireMembership: vi.fn(),
}));

const { GET: CELLAR } = await import("./cellar/route");
const { GET: EXPORT } = await import("./export/route");
const { GET: INVENTORY } = await import("./inventory/route");
const { GET: RESTAURANT } = await import("./restaurant/route");
const { GET: SCANS } = await import("./scans/route");
const { GET: TEAM } = await import("./team/route");
const { GET: WINE_LIST_ITEMS } = await import("./wine-list-items/route");
const { GET: WINE_LIST_SECTIONS } = await import("./wine-list-sections/route");
const { GET: WINE_LISTS } = await import("./wine-lists/route");
const { GET: WINES } = await import("./wines/route");

const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

type Call = { table: string; filters: Array<[string, unknown]> };

function makeSupabase() {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const call: Call = { table, filters: [] };
    calls.push(call);
    const result = () => ({ data: [], error: null, count: 0 });
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      ilike: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      is: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      in: () => chain,
      or: () => chain,
      order: () => chain,
      range: () => chain,
      maybeSingle: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return chain;
  });
  return { from, calls, client: { from } };
}

function authenticate() {
  const supabase = makeSupabase();
  auth.requireCapability.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "staff",
    user: { id: "33333333-3333-4333-8333-333333333333" },
  });
  return supabase;
}

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

const operations = [
  { name: "cellar", capability: "cellar:view", call: () => CELLAR() },
  { name: "export", capability: "export:read", call: () => EXPORT() },
  { name: "inventory", capability: "cellar:view", call: () => INVENTORY() },
  { name: "restaurant", capability: "restaurant:view", call: () => RESTAURANT() },
  { name: "scans", capability: "scan:create", call: () => SCANS(request("/api/scans")) },
  { name: "team", capability: "team:view", call: () => TEAM() },
  {
    name: "wine-list-items",
    capability: "wine-list:view",
    call: () => WINE_LIST_ITEMS(request(`/api/wine-list-items?section_id=${RESTAURANT_ID}`)),
  },
  {
    name: "wine-list-sections",
    capability: "wine-list:view",
    call: () => WINE_LIST_SECTIONS(request(`/api/wine-list-sections?wine_list_id=${RESTAURANT_ID}`)),
  },
  { name: "wine-lists", capability: "wine-list:view", call: () => WINE_LISTS() },
  { name: "wines", capability: "wine:view", call: () => WINES(request("/api/wines")) },
] as const;

describe("TER-020E compatibility collection GET routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(operations)("returns auth denial before querying $name", async ({ call }) => {
    const denial = NextResponse.json(
      { error: { code: "forbidden", message: "Forbidden" } },
      { status: 403 },
    );
    auth.requireCapability.mockResolvedValue(denial);

    await expect(call()).resolves.toBe(denial);
  });

  it.each(operations)("uses the declared capability for $name", async ({ capability, call }) => {
    authenticate();

    const response = await call();

    expect(response.status).toBe(200);
    expect(auth.requireCapability.mock.calls[0]?.[0]).toBe(capability);
  });

  it("scopes every table-backed collection query to the active restaurant", async () => {
    const supabase = authenticate();

    await Promise.all(operations.map(({ call }) => call()));

    for (const call of supabase.calls) {
      if (call.table === "wine_list_items") continue;
      const tenantColumn =
        call.table === "restaurants" ? "id" : expect.stringContaining("restaurant_id");
      expect(call.filters).toContainEqual(
        expect.arrayContaining([tenantColumn, RESTAURANT_ID]),
      );
    }
  });

  it.each([
    () => WINES(request("/api/wines?limit=duplicate&limit=5")),
    () => SCANS(request("/api/scans?status=unknown")),
    () => WINE_LIST_SECTIONS(request("/api/wine-list-sections?wine_list_id=nope")),
    () => WINE_LIST_ITEMS(request("/api/wine-list-items?section_id=nope")),
  ])("rejects malformed collection filters before querying", async (call) => {
    const supabase = authenticate();

    const response = await call();

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
