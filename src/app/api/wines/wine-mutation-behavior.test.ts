import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  requireRole: vi.fn(),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) => auth.requireRole(...args),
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));
vi.mock("@sentry/nextjs", () => sentry);
vi.mock("next/cache", () => cache);

const { PATCH: UPDATE_WINE } = await import("./[id]/route");
const { PATCH: AVAILABILITY } = await import("./[id]/availability/route");
const { POST: DISMISS } = await import(
  "./[id]/dismiss-pricing-alert/route"
);
const { POST: OVERPAID } = await import("./[id]/overpaid/route");
const { PATCH: TARGETS } = await import("./[id]/pricing-targets/route");
const { POST: SNOOZE } = await import("./[id]/snooze-alert/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

type DbError = { message: string; code?: string };
type DbPlan = {
  table: string;
  data?: unknown;
  error?: DbError | null;
};
type RpcPlan = {
  fn: string;
  data?: unknown;
  error?: DbError | null;
};
type Call = {
  table: string;
  action: string;
  payload?: unknown;
  filters: Array<[string, unknown]>;
};

function makeSupabase(dbPlans: DbPlan[], rpcPlans: RpcPlan[] = []) {
  const calls: Call[] = [];
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
    const call: Call = { table, action: "query", filters: [] };
    calls.push(call);
    const result = () => ({
      data: plan.data ?? null,
      error: plan.error ?? null,
    });
    const chain = {
      select: (_columns?: string) => chain,
      update: (payload: unknown) => {
        call.action = "update";
        call.payload = payload;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => result(),
    };
    return chain;
  });
  return { calls, client: { from, rpc }, rpc };
}

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function setRoleAuth(
  dbPlans: DbPlan[],
  rpcPlans: RpcPlan[] = [],
) {
  const supabase = makeSupabase(dbPlans, rpcPlans);
  auth.requireRole.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
  return supabase;
}

describe("wine mutation behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when a metadata update affects no tenant row", async () => {
    setRoleAuth([{ table: "wines", data: null }]);

    const response = await UPDATE_WINE(
      request(`/api/wines/${WINE_ID}`, "PATCH", { name: "Reserve" }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(404);
  });

  it("returns a redacted 500 for a metadata provider failure", async () => {
    setRoleAuth([
      { table: "wines", error: { message: "provider unavailable" } },
    ]);

    const response = await UPDATE_WINE(
      request(`/api/wines/${WINE_ID}`, "PATCH", { name: "Reserve" }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("maps a metadata identity conflict to wine_collision", async () => {
    setRoleAuth([
      {
        table: "wines",
        error: { message: "duplicate", code: "23505" },
      },
    ]);

    const response = await UPDATE_WINE(
      request(`/api/wines/${WINE_ID}`, "PATCH", { name: "Reserve" }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("wine_collision");
  });

  it("validates a partial drink-window patch against stored values", async () => {
    const supabase = setRoleAuth([
      {
        table: "wines",
        data: {
          drink_window_start: 2025,
          drink_window_end: 2035,
          peak_year: 2030,
        },
      },
    ]);

    const response = await UPDATE_WINE(
      request(`/api/wines/${WINE_ID}`, "PATCH", {
        drink_window_end: 2024,
      }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("invalid_drink_window");
    expect(supabase.calls).toHaveLength(1);
    expect(supabase.calls[0].action).toBe("query");
  });

  it("records manual override categories after metadata changes", async () => {
    const supabase = setRoleAuth(
      [
        {
          table: "wines",
          data: {
            id: WINE_ID,
            name: "Reserve",
            region: "Napa",
          },
        },
      ],
      [{ fn: "add_manual_overrides", data: null }],
    );

    const response = await UPDATE_WINE(
      request(`/api/wines/${WINE_ID}`, "PATCH", { region: "Napa" }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith("add_manual_overrides", {
      p_wine_id: WINE_ID,
      p_fields: ["region"],
    });
  });

  it("does not report metadata success when override tracking fails", async () => {
    setRoleAuth(
      [
        {
          table: "wines",
          data: { id: WINE_ID, region: "Napa" },
        },
      ],
      [
        {
          fn: "add_manual_overrides",
          error: { message: "override tracking failed" },
        },
      ],
    );

    const response = await UPDATE_WINE(
      request(`/api/wines/${WINE_ID}`, "PATCH", { region: "Napa" }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
  });

  it("returns 500 when availability cache repair lookup fails", async () => {
    const event = {
      direction: "eightysixed",
      created_at: "2026-07-24T12:00:00.000Z",
    };
    setRoleAuth(
      [{ table: "wines", data: { id: WINE_ID } }],
      [
        { fn: "set_wine_availability", data: [event] },
        {
          fn: "wine_published_list_slugs",
          error: { message: "cache lookup failed" },
        },
      ],
    );

    const response = await AVAILABILITY(
      request(`/api/wines/${WINE_ID}/availability`, "PATCH", {
        direction: "eightysixed",
      }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledWith(
      { message: "cache lookup failed" },
    );
  });

  it("revalidates public lists even when availability is already in target state", async () => {
    setRoleAuth(
      [{ table: "wines", data: { id: WINE_ID } }],
      [
        { fn: "set_wine_availability", data: [] },
        {
          fn: "wine_published_list_slugs",
          data: [{ slug: "dinner" }],
        },
      ],
    );

    const response = await AVAILABILITY(
      request(`/api/wines/${WINE_ID}/availability`, "PATCH", {
        direction: "eightysixed",
      }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: false });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/list/dinner");
  });

  it("does not report a cleared pricing dismissal after a zero-row race", async () => {
    setRoleAuth([
      { table: "wines", data: { id: WINE_ID } },
      { table: "wines", data: null },
    ]);

    const response = await DISMISS(
      request(`/api/wines/${WINE_ID}/dismiss-pricing-alert`, "POST", {
        days: 0,
      }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(404);
  });

  it("does not report an overpaid toggle after a zero-row race", async () => {
    const supabase = setRoleAuth([
      {
        table: "wines",
        data: { id: WINE_ID, overpaid_flag: false },
      },
      { table: "wines", data: null },
    ]);

    const response = await OVERPAID(
      request(`/api/wines/${WINE_ID}/overpaid`, "POST"),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(404);
    expect(supabase.calls[1]).toMatchObject({
      action: "update",
      payload: { overpaid_flag: true },
      filters: [
        ["id", WINE_ID],
        ["restaurant_id", RESTAURANT_ID],
      ],
    });
  });

  it("rejects a snooze RPC success without a timestamp", async () => {
    setRoleAuth(
      [{ table: "wines", data: { id: WINE_ID } }],
      [{ fn: "snooze_drink_window_alert", data: null }],
    );

    const response = await SNOOZE(
      request(`/api/wines/${WINE_ID}/snooze-alert`, "POST", { days: 30 }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
  });

  it("distinguishes pricing-target provider failure from missing wine", async () => {
    setRoleAuth([
      { table: "wines", error: { message: "provider unavailable" } },
    ]);

    const response = await TARGETS(
      request(`/api/wines/${WINE_ID}/pricing-targets`, "PATCH", {
        markup_ratio: 2,
      }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
  });
});
