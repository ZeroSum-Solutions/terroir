import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  assignCellarWineSection,
  assignCellarWineSections,
  CellarBatchSectionError,
  chunkCellarWineIds,
} from "@/lib/cellar/batch-section";
import { createIdempotentCommandStore } from "@/lib/api/idempotency-client";

const auth = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  requireRole: vi.fn(),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
const intelligence = vi.hoisted(() => ({ enrichWine: vi.fn() }));

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));
vi.mock("@sentry/nextjs", () => sentry);
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: (...args: unknown[]) => intelligence.enrichWine(...args),
}));

const { POST: ADD_WINE } = await import("./route");
const { POST: BATCH_SECTION } = await import("./batch-section/route");
const { GET: GRID } = await import("./grid/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WINE_ID = "33333333-3333-4333-8333-333333333333";
const INVENTORY_ID = "44444444-4444-4444-8444-444444444444";
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
  throws?: Error;
};

function makeSupabase(dbPlans: DbPlan[], rpcPlans: RpcPlan[] = []) {
  const calls: Array<{
    table: string;
    action: "query" | "insert" | "update";
    payload?: unknown;
    filters: Array<[string, unknown]>;
    ranges: Array<[number, number]>;
    limits: number[];
  }> = [];
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    const plan = rpcPlans.shift();
    if (!plan) throw new Error(`Unexpected RPC ${fn}`);
    if (plan.fn !== fn) {
      throw new Error(`Expected RPC ${plan.fn}, received ${fn}`);
    }
    if (plan.throws) throw plan.throws;
    return { data: plan.data ?? null, error: plan.error ?? null, args };
  });
  const from = vi.fn((table: string) => {
    const plan = dbPlans.shift();
    if (!plan) throw new Error(`Unexpected database call to ${table}`);
    if (plan.table !== table) {
      throw new Error(`Expected ${plan.table}, received ${table}`);
    }
    const call = {
      table,
      action: "query",
      filters: [],
      ranges: [],
      limits: [],
    } as {
      table: string;
      action: "query" | "insert" | "update";
      payload?: unknown;
      filters: Array<[string, unknown]>;
      ranges: Array<[number, number]>;
      limits: number[];
    };
    calls.push(call);
    const result = () => ({
      data: plan.data ?? null,
      error: plan.error ?? null,
    });
    const chain = {
      select: () => chain,
      insert: (payload: unknown) => {
        call.action = "insert";
        call.payload = payload;
        return chain;
      },
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
      not: (column: string, operator: string, value: unknown) => {
        call.filters.push([column, [operator, value]]);
        return chain;
      },
      gt: (column: string, value: unknown) => {
        call.filters.push([column, [">", value]]);
        return chain;
      },
      order: () => chain,
      limit: (value: number) => {
        call.limits.push(value);
        return chain;
      },
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
  return { calls, client: { from, rpc }, from, rpc };
}

function allowRole(dbPlans: DbPlan[], rpcPlans: RpcPlan[] = []) {
  const supabase = makeSupabase(dbPlans, rpcPlans);
  auth.requireRole.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
  return supabase;
}

function allowMembership(dbPlans: DbPlan[]) {
  const supabase = makeSupabase(dbPlans);
  auth.requireMembership.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "staff",
  });
  return supabase;
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RULE_RESULT = {
  drinkWindowStart: 2024,
  drinkWindowEnd: 2034,
  peakYear: 2029,
  ratingSource: "rule_engine",
  reviewExcerpt: "Ready with air.",
  servingTempMin: 14,
  servingTempMax: 16,
  servingTempLabel: "Cellar",
  decantMinutes: 45,
};

function gridRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVENTORY_ID,
    bin_location: "A-1",
    quantity: 2,
    wines: {
      id: WINE_ID,
      name: "Reserve",
      producer: "Domaine Test",
      vintage: 2020,
    },
    ...overrides,
  };
}

describe("cellar collection behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelligence.enrichWine.mockReset();
    intelligence.enrichWine.mockReturnValue(RULE_RESULT);
  });

  it("matches LWIN before enriching from canonical stored wine fields", async () => {
    const supabase = allowRole(
      [
        {
          table: "wines",
          data: {
            varietal: "Pinot Noir",
            region: "Burgundy",
            country: "France",
            vintage: 2020,
          },
        },
      ],
      [
        {
          fn: "add_cellar_wine_idempotent",
          data: [{
            outcome: "added",
            response_status: 200,
            response_body: {
              wineId: WINE_ID,
              inventoryId: INVENTORY_ID,
              quantity: 3,
              unitCost: 25,
            },
            replayed: false,
          }],
        },
        { fn: "match_lwin_batch", data: [] },
        { fn: "enrich_wines_batch", data: 1 },
      ],
    );

    const response = await ADD_WINE(
      request("/api/cellar", {
        name: "Reserve",
        producer: "Domaine Test",
        varietal: "Merlot",
        region: "Napa",
        country: "United States",
        vintage: 2020,
        quantity: 3,
        unit_cost: 25,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      wineId: WINE_ID,
      inventoryId: INVENTORY_ID,
      quantity: 3,
      unitCost: 25,
    });
    expect(supabase.rpc.mock.calls[0]).toEqual([
      "add_cellar_wine_idempotent",
      expect.objectContaining({
        p_restaurant_id: RESTAURANT_ID,
        p_name: "Reserve",
        p_producer: "Domaine Test",
      }),
    ]);
    expect(intelligence.enrichWine).toHaveBeenCalledWith({
      varietal: "Pinot Noir",
      region: "Burgundy",
      country: "France",
      vintage: 2020,
    });
    expect(supabase.rpc.mock.calls.map(([fn]) => fn)).toEqual([
      "add_cellar_wine_idempotent",
      "match_lwin_batch",
      "enrich_wines_batch",
    ]);
    const enrichCall = supabase.rpc.mock.calls.find(
      ([fn]) => fn === "enrich_wines_batch",
    );
    expect(enrichCall?.[1]).toMatchObject({
      p_restaurant_id: RESTAURANT_ID,
      p_enrichments: [
        expect.objectContaining({
          id: WINE_ID,
          decant_minutes: 45,
        }),
      ],
    });
  });

  it("reports inventory success while capturing best-effort enrichment failures", async () => {
    allowRole(
      [
        {
          table: "wines",
          data: {
            varietal: "Pinot Noir",
            region: "Burgundy",
            country: "France",
            vintage: 2020,
          },
        },
      ],
      [
        {
          fn: "add_cellar_wine_idempotent",
          data: [{
            outcome: "added",
            response_status: 200,
            response_body: {
              wineId: WINE_ID,
              inventoryId: INVENTORY_ID,
              quantity: 1,
              unitCost: 0,
            },
            replayed: false,
          }],
        },
        {
          fn: "match_lwin_batch",
          error: { message: "LWIN failed" },
        },
        {
          fn: "enrich_wines_batch",
          error: { message: "enrichment failed" },
        },
      ],
    );

    const response = await ADD_WINE(
      request("/api/cellar", {
        name: "Reserve",
        producer: "Domaine Test",
      }),
    );

    expect(response.status).toBe(200);
    expect(sentry.captureException).toHaveBeenCalledWith(
      { message: "enrichment failed" },
      expect.objectContaining({
        tags: { surface: "cellar", phase: "enrich-wine" },
      }),
    );
    expect(sentry.captureException).toHaveBeenCalledWith(
      { message: "LWIN failed" },
      expect.objectContaining({
        tags: { surface: "cellar", phase: "match-lwin" },
      }),
    );
  });

  it("keeps a durable add successful when LWIN and error reporting throw", async () => {
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error("Sentry unavailable");
    });
    intelligence.enrichWine.mockReturnValue({
      drinkWindowStart: null,
      servingTempMin: null,
    });
    allowRole(
      [
        {
          table: "wines",
          data: {
            varietal: null,
            region: null,
            country: null,
            vintage: null,
          },
        },
      ],
      [
        {
          fn: "add_cellar_wine_idempotent",
          data: [{
            outcome: "added",
            response_status: 200,
            response_body: {
              wineId: WINE_ID,
              inventoryId: INVENTORY_ID,
              quantity: 1,
              unitCost: 0,
            },
            replayed: false,
          }],
        },
        {
          fn: "match_lwin_batch",
          throws: new Error("transport failed"),
        },
      ],
    );

    const response = await ADD_WINE(
      request("/api/cellar", {
        name: "Reserve",
        producer: "Domaine Test",
      }),
    );

    expect(response.status).toBe(200);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not report add-wine success for an invalid inventory result", async () => {
    allowRole(
      [],
      [{
        fn: "add_cellar_wine_idempotent",
        data: [{
          outcome: "added",
          response_status: 200,
          response_body: {
            wineId: WINE_ID,
            inventoryId: "not-a-uuid",
            quantity: 1,
            unitCost: 0,
          },
          replayed: false,
        }],
      }],
    );

    const response = await ADD_WINE(
      request("/api/cellar", {
        name: "Reserve",
        producer: "Domaine Test",
      }),
    );

    expect(response.status).toBe(500);
  });

  it("does not report atomic batch success when inventory is missing", async () => {
    const supabase = allowRole(
      [],
      [
        {
          fn: "assign_cellar_section_batch",
          error: { message: "cellar_inventory_missing" },
        },
      ],
    );

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID, OTHER_WINE_ID],
        section: "Reserve",
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Inventory item not found.",
      },
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("atomically updates every requested wine in one provider call", async () => {
    const supabase = allowRole(
      [],
      [
        {
          fn: "assign_cellar_section_batch",
          data: null,
        },
      ],
    );

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID, OTHER_WINE_ID],
        section: "Reserve",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: 2,
      section: "Reserve",
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "assign_cellar_section_batch",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_ids: [WINE_ID, OTHER_WINE_ID],
        p_section: "Reserve",
      },
    );
  });

  it("rejects an assignment to an unconfigured section", async () => {
    const supabase = allowRole([], [
      {
        fn: "assign_cellar_section_batch",
        error: { message: "cellar_section_not_configured" },
      },
    ]);

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID],
        section: "Hidden",
      }),
    );

    expect(response.status).toBe(400);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not report batch success when the provider update fails", async () => {
    allowRole([], [
      {
        fn: "assign_cellar_section_batch",
        error: { message: "update failed" },
      },
    ]);

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID],
        section: "Reserve",
      }),
    );

    expect(response.status).toBe(500);
  });

  it("maps provider-side duplicate and size guards to safe client errors", async () => {
    allowRole([], [
      {
        fn: "assign_cellar_section_batch",
        error: { message: "cellar_batch_invalid_size" },
      },
    ]);

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID],
        section: "Reserve",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(
      "Invalid cellar batch.",
    );
  });

  it("canonically sorts and chunks more than 200 selected wines", () => {
    const ids = Array.from(
      { length: 401 },
      (_, index) => `wine-${String(400 - index).padStart(3, "0")}`,
    );
    const chunks = chunkCellarWineIds(ids);

    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 1]);
    expect(chunks.flat()).toEqual([...ids].sort());
  });

  it("posts 401 IDs as 200/200/1 with distinct command keys", async () => {
    const ids = Array.from(
      { length: 401 },
      (_, index) => `wine-${String(400 - index).padStart(3, "0")}`,
    );
    const request = vi
      .fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          wine_ids: string[];
          section: string;
        };
        return Response.json({
          updated: body.wine_ids.length,
          section: body.section,
        });
      });
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    await expect(assignCellarWineSections({
      wineIds: ids,
      section: "Reserve",
      commands,
    })).resolves.toBe(401);

    expect(request).toHaveBeenCalledTimes(3);
    const bodies = request.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as { wine_ids: string[] },
    );
    expect(bodies.map(({ wine_ids }) => wine_ids.length)).toEqual([
      200,
      200,
      1,
    ]);
    expect(bodies.flatMap(({ wine_ids }) => wine_ids)).toEqual(
      [...ids].sort(),
    );
    const keys = request.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("normalizes a padded bulk section before sending and validating", async () => {
    const request = vi.fn<typeof fetch>(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          wine_ids: string[];
          section: string;
        };
        return Response.json({
          updated: body.wine_ids.length,
          section: body.section,
        });
      },
    );
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    await expect(assignCellarWineSections({
      wineIds: [WINE_ID],
      section: "  Reserve  ",
      commands,
    })).resolves.toBe(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      wine_ids: [WINE_ID],
      section: "Reserve",
    });
  });

  it("retries only a failed suffix with the same failed-chunk key", async () => {
    const ids = Array.from(
      { length: 401 },
      (_, index) => `wine-${String(index).padStart(3, "0")}`,
    );
    const request = vi.fn<typeof fetch>(
      async (_url, init) => {
        const call = request.mock.calls.length;
        const body = JSON.parse(String(init?.body)) as {
          wine_ids: string[];
          section: string;
        };
        if (call === 2) {
          return Response.json(
            { error: { message: "Provider unavailable." } },
            { status: 503 },
          );
        }
        return Response.json({
          updated: body.wine_ids.length,
          section: body.section,
        });
      },
    );
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    await expect(assignCellarWineSections({
      wineIds: ids,
      section: "Reserve",
      commands,
    })).rejects.toMatchObject({
      name: "CellarBatchSectionError",
      message: "Provider unavailable.",
      assignedCount: 200,
    } satisfies Partial<CellarBatchSectionError>);

    await expect(assignCellarWineSections({
      wineIds: ids.slice(200),
      section: "Reserve",
      commands,
    })).resolves.toBe(201);

    expect(request).toHaveBeenCalledTimes(4);
    const bodies = request.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as { wine_ids: string[] },
    );
    expect(bodies[0]?.wine_ids).toEqual(ids.slice(0, 200));
    expect(bodies[1]?.wine_ids).toEqual(ids.slice(200, 400));
    expect(bodies[2]?.wine_ids).toEqual(ids.slice(200, 400));
    expect(bodies[3]?.wine_ids).toEqual(ids.slice(400));
    const keys = request.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get("Idempotency-Key"),
    );
    expect(keys[2]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("uses one retry key per wine and exact target", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Provider unavailable." } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ wine_id: WINE_ID, section: "Reserve" }),
      )
      .mockResolvedValueOnce(
        Response.json({ wine_id: WINE_ID, section: "Library" }),
      );
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    await expect(assignCellarWineSection({
      wineId: WINE_ID,
      section: "Reserve",
      commands,
    })).rejects.toThrow("Provider unavailable.");
    await expect(assignCellarWineSection({
      wineId: WINE_ID,
      section: "Reserve",
      commands,
    })).resolves.toEqual({
      wine_id: WINE_ID,
      section: "Reserve",
    });
    await expect(assignCellarWineSection({
      wineId: WINE_ID,
      section: "Library",
      commands,
    })).resolves.toEqual({
      wine_id: WINE_ID,
      section: "Library",
    });

    const keys = request.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("normalizes a padded section before keying, sending, and validating", async () => {
    const request = vi.fn<typeof fetch>(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          section: string;
        };
        return Response.json({
          wine_id: WINE_ID,
          section: body.section,
        });
      },
    );
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    await expect(assignCellarWineSection({
      wineId: WINE_ID,
      section: "  Reserve  ",
      commands,
    })).resolves.toEqual({
      wine_id: WINE_ID,
      section: "Reserve",
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      section: "Reserve",
    });
  });

  it("coalesces the same wine command while distinct wine slots proceed", async () => {
    const resolvers = new Map<string, (response: Response) => void>();
    const request = vi.fn<typeof fetch>(
      (url) =>
        new Promise<Response>((resolve) => {
          resolvers.set(String(url), resolve);
        }),
    );
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    const first = assignCellarWineSection({
      wineId: WINE_ID,
      section: "Reserve",
      commands,
    });
    const duplicate = assignCellarWineSection({
      wineId: WINE_ID,
      section: "Reserve",
      commands,
    });
    const distinct = assignCellarWineSection({
      wineId: OTHER_WINE_ID,
      section: "Reserve",
      commands,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    resolvers.get(`/api/cellar/${WINE_ID}/section`)?.(
      Response.json({ wine_id: WINE_ID, section: "Reserve" }),
    );
    resolvers.get(`/api/cellar/${OTHER_WINE_ID}/section`)?.(
      Response.json({
        wine_id: OTHER_WINE_ID,
        section: "Reserve",
      }),
    );

    await expect(Promise.all([first, duplicate, distinct])).resolves.toEqual([
      { wine_id: WINE_ID, section: "Reserve" },
      { wine_id: WINE_ID, section: "Reserve" },
      { wine_id: OTHER_WINE_ID, section: "Reserve" },
    ]);
    const keys = request.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get("Idempotency-Key"),
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("uses new bulk keys when the target or exact selection changes", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        Response.json(
          { error: { message: "Provider unavailable." } },
          { status: 503 },
        ),
    );
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });
    const firstSelection = ["wine-a", "wine-b", "wine-z"];
    const changedMiddleSelection = ["wine-a", "wine-c", "wine-z"];

    await expect(assignCellarWineSections({
      wineIds: firstSelection,
      section: "Reserve",
      commands,
    })).rejects.toThrow("Provider unavailable.");
    await expect(assignCellarWineSections({
      wineIds: firstSelection,
      section: "Library",
      commands,
    })).rejects.toThrow("Provider unavailable.");
    await expect(assignCellarWineSections({
      wineIds: changedMiddleSelection,
      section: "Reserve",
      commands,
    })).rejects.toThrow("Provider unavailable.");

    const keys = request.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    { updated: 0, section: "Reserve" },
    { updated: 1, section: "Wrong" },
    { ok: true },
  ])("rejects malformed or mismatched 2xx batch data %#", async (payload) => {
    const response = Response.json(payload);
    const json = vi.spyOn(response, "json");
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const commands = createIdempotentCommandStore({
      fetchImpl: request,
    });

    await expect(assignCellarWineSections({
      wineIds: [WINE_ID],
      section: "Reserve",
      commands,
    })).rejects.toMatchObject({
      name: "CellarBatchSectionError",
      assignedCount: 0,
    });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("paginates, normalizes bins, and aggregates repeated wines", async () => {
    const filler = Array.from({ length: 998 }, (_, index) =>
      gridRow({
        id: `${String(index + 1).padStart(8, "0")}-5555-4555-8555-555555555555`,
        bin_location: " ",
        wines: null,
      }),
    );
    const supabase = allowMembership([
      {
        table: "inventory_items",
        data: [
          ...filler,
          gridRow(),
          gridRow({
            id: "55555555-5555-4555-8555-555555555555",
            bin_location: " a-1 ",
            quantity: 1,
            wines: [
              {
                id: WINE_ID,
                name: "Reserve",
                producer: "Domaine Test",
                vintage: 2020,
              },
            ],
          }),
        ],
      },
      {
        table: "inventory_items",
        data: [
          gridRow({
            id: "66666666-6666-4666-8666-666666666666",
            bin_location: "A-1",
            quantity: 3,
          }),
          gridRow({
            id: "77777777-7777-4777-8777-777777777777",
            bin_location: "B-2",
            quantity: 4,
            wines: {
              id: OTHER_WINE_ID,
              name: "Second",
              producer: "Alpha",
              vintage: 2019,
            },
          }),
          gridRow({
            id: "88888888-8888-4888-8888-888888888888",
            bin_location: "C-3",
            quantity: 0,
          }),
        ],
      },
    ]);

    const response = await GRID();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      "A-1": {
        wines: [
          {
            wineId: WINE_ID,
            name: "Reserve",
            producer: "Domaine Test",
            vintage: 2020,
            quantity: 6,
          },
        ],
        totalBottles: 6,
      },
      "B-2": {
        wines: [
          {
            wineId: OTHER_WINE_ID,
            name: "Second",
            producer: "Alpha",
            vintage: 2019,
            quantity: 4,
          },
        ],
        totalBottles: 4,
      },
    });
    expect(supabase.calls.map((call) => call.limits)).toEqual([
      [1000],
      [1000],
    ]);
    expect(supabase.calls.map((call) => call.ranges)).toEqual([[], []]);
    expect(supabase.calls[1]?.filters).toContainEqual([
      "id",
      [">", "55555555-5555-4555-8555-555555555555"],
    ]);
  });

  it("accepts exactly 10,000 grid rows after checking for overflow", async () => {
    const supabase = allowMembership([
      ...Array.from({ length: 10 }, (_, pageIndex) => ({
        table: "inventory_items",
        data: Array.from({ length: 1000 }, (_, index) =>
          gridRow({
            id: `${String(pageIndex * 1000 + index + 1).padStart(8, "0")}-9999-4999-8999-999999999999`,
          }),
        ),
      })),
      { table: "inventory_items", data: [] },
    ]);

    const response = await GRID();

    expect(response.status).toBe(200);
    expect(supabase.calls.at(-1)?.ranges).toEqual([]);
    expect(supabase.calls.at(-1)?.limits).toEqual([1]);
    expect(supabase.calls.at(-1)?.filters).toContainEqual([
      "id",
      [">", "00010000-9999-4999-8999-999999999999"],
    ]);
  });

  it("rejects a grid that exceeds the honest 10,000-row cap", async () => {
    allowMembership([
      ...Array.from({ length: 10 }, (_, pageIndex) => ({
        table: "inventory_items",
        data: Array.from({ length: 1000 }, (_, index) =>
          gridRow({
            id: `${String(pageIndex * 1000 + index + 1).padStart(8, "0")}-8888-4888-8888-888888888888`,
          }),
        ),
      })),
      { table: "inventory_items", data: [gridRow()] },
    ]);

    const response = await GRID();

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("returns a redacted failure instead of a partial grid", async () => {
    allowMembership([
      {
        table: "inventory_items",
        data: Array.from({ length: 1000 }, () => gridRow()),
      },
      {
        table: "inventory_items",
        error: { message: "second page failed" },
      },
    ]);

    const response = await GRID();

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });
});
