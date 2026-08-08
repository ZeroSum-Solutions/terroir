import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireCapability: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireCapability(...args),
  requireRole: (...args: unknown[]) => auth.requireCapability(...args),
}));

const { GET: GET_WINE } = await import("./wines/[id]/route");
const { GET: GET_SCAN } = await import("./scans/[id]/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const SCAN_ID = "22222222-2222-4222-8222-222222222222";
const RESTAURANT_ID = "33333333-3333-4333-8333-333333333333";

type ReadPlan = { data: unknown; error: unknown };

function readClient(plan: ReadPlan) {
  const filters: Array<[string, unknown]> = [];
  const selected: string[] = [];
  const query = {
    select: vi.fn((columns: string) => {
      selected.push(columns);
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    }),
    maybeSingle: vi.fn(async () => plan),
  };
  const from = vi.fn(() => query);
  return { client: { from }, from, filters, selected };
}

function authorize(client: unknown) {
  auth.requireCapability.mockResolvedValue({
    supabase: client,
    restaurantId: RESTAURANT_ID,
    user: { id: "44444444-4444-4444-8444-444444444444" },
    role: "staff",
  });
}

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

describe("TER-020E exact compatibility reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      name: "wine",
      id: WINE_ID,
      call: (params: Promise<{ id: string }>) =>
        GET_WINE(request(`/api/wines/${WINE_ID}`), {
          params,
        }),
    },
    {
      name: "scan",
      id: SCAN_ID,
      call: (params: Promise<{ id: string }>) =>
        GET_SCAN(request(`/api/scans/${SCAN_ID}`), {
          params,
        }),
    },
  ])("returns the exact auth denial for $name before resolving params", async ({ call, id }) => {
    const denial = NextResponse.json(
      { error: { code: "unauthorized", message: "Unauthorized" } },
      { status: 401 },
    );
    auth.requireCapability.mockResolvedValue(denial);
    let touches = 0;
    const params = {
      then(resolve: (value: { id: string }) => void) {
        touches += 1;
        resolve({ id });
      },
    } as unknown as Promise<{ id: string }>;

    const response = await call(params);

    expect(response).toBe(denial);
    expect(touches).toBe(0);
  });

  it.each([
    {
      name: "wine",
      call: () =>
        GET_WINE(request("/api/wines/not-a-uuid"), {
          params: Promise.resolve({ id: "not-a-uuid" }),
        }),
    },
    {
      name: "scan",
      call: () =>
        GET_SCAN(request("/api/scans/not-a-uuid"), {
          params: Promise.resolve({ id: "not-a-uuid" }),
        }),
    },
  ])("rejects an invalid $name ID before database work", async ({ call }) => {
    const db = readClient({ data: null, error: null });
    authorize(db.client);

    const response = await call();

    expect(response.status).toBe(400);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns one tenant-scoped wine including enrichment fields", async () => {
    const wine = {
      id: WINE_ID,
      name: "Barolo",
      drink_window_start: 2026,
      peak_year: 2030,
      drink_window_end: 2036,
      serving_temp_label: "Cellar cool",
      decant_minutes: 60,
      enrichment_metadata: { source: "rule_engine" },
    };
    const db = readClient({ data: wine, error: null });
    authorize(db.client);

    const response = await GET_WINE(request(`/api/wines/${WINE_ID}`), {
      params: Promise.resolve({ id: WINE_ID.toUpperCase() }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wine });
    expect(db.from).toHaveBeenCalledWith("wines");
    expect(db.selected).toEqual(["*"]);
    expect(db.filters).toEqual([
      ["id", WINE_ID],
      ["restaurant_id", RESTAURANT_ID],
    ]);
  });

  it("returns one tenant-scoped scan with final line items", async () => {
    const scan = {
      id: SCAN_ID,
      status: "review",
      final_line_items: [{ name: "Barolo", qty: 2, unitCost: 95 }],
    };
    const db = readClient({ data: scan, error: null });
    authorize(db.client);

    const response = await GET_SCAN(request(`/api/scans/${SCAN_ID}`), {
      params: Promise.resolve({ id: SCAN_ID.toUpperCase() }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scan });
    expect(db.from).toHaveBeenCalledWith("invoice_scans");
    expect(db.selected[0]).toContain("final_line_items");
    expect(db.filters).toEqual([
      ["id", SCAN_ID],
      ["restaurant_id", RESTAURANT_ID],
    ]);
  });

  it.each([
    {
      name: "wine",
      call: () =>
        GET_WINE(request(`/api/wines/${WINE_ID}`), {
          params: Promise.resolve({ id: WINE_ID }),
        }),
    },
    {
      name: "scan",
      call: () =>
        GET_SCAN(request(`/api/scans/${SCAN_ID}`), {
          params: Promise.resolve({ id: SCAN_ID }),
        }),
    },
  ])("distinguishes missing $name from a provider failure", async ({ call }) => {
    const missing = readClient({ data: null, error: null });
    authorize(missing.client);
    const missingResponse = await call();
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const failed = readClient({
      data: null,
      error: { message: "private provider detail" },
    });
    authorize(failed.client);
    const failedResponse = await call();
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });
});
