import { type NextRequest } from "next/server";
import { vi } from "vitest";

export const BOTTLE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
export const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
export const REASON_ID = "d1b2c3d4-e5f6-4789-8abc-def012345678";

type Options = {
  bottle?: Record<string, unknown> | null;
  reason?: Record<string, unknown> | null;
  events?: Array<{ ml_delta: number; kind: string }>;
  closeoutError?: { code?: string; message?: string } | null;
  finishError?: { code?: string; message?: string } | null;
};

type Call = { table: string; method: string; payload: unknown };

export function makeClients(options: Options = {}) {
  const bottle = options.bottle === undefined
    ? {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        restaurant_id: "r-A",
        opened_at: "2026-08-18T17:00:00.000Z",
        opened_by: "u-open",
        preservation_method: "coravin",
        remaining_ml: 500,
        closed_at: null,
        wines: { size_ml: 750 },
      }
    : options.bottle;
  const reason = options.reason === undefined
    ? { id: REASON_ID, restaurant_id: "r-A", category: "spoilage", active: true }
    : options.reason;
  const events = options.events ?? [
    { ml_delta: 100, kind: "pour" },
    { ml_delta: 50, kind: "spill" },
  ];
  const authCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const serviceCalls: Call[] = [];
  const auth = makeAuthClient(bottle, reason, events, authCalls);
  const service = makeServiceClient(options, serviceCalls);

  return { auth, service, authCalls, serviceCalls };
}

function makeAuthClient(
  bottle: Record<string, unknown> | null,
  reason: Record<string, unknown> | null,
  events: Array<{ ml_delta: number; kind: string }>,
  calls: Array<{ table: string; method: string; args: unknown[] }>,
) {
  return {
    from: vi.fn((table: string) => makeAuthChain(table, bottle, reason, events, calls)),
  };
}

function makeAuthChain(
  table: string,
  bottle: Record<string, unknown> | null,
  reason: Record<string, unknown> | null,
  events: Array<{ ml_delta: number; kind: string }>,
  calls: Array<{ table: string; method: string; args: unknown[] }>,
) {
  const chain = {
    select: (...args: unknown[]) => track("select", args),
    eq: (column: string, value: unknown) => track("eq", [column, value]),
    is: (...args: unknown[]) => track("is", args),
    in: (...args: unknown[]) => track("in", args),
    gte: (...args: unknown[]) => track("gte", args),
    order: (...args: unknown[]) => track("order", args),
    limit: (...args: unknown[]) => track("limit", args),
    maybeSingle: async () => ({
      data: table === "open_bottles" ? bottle : reason,
      error: null,
    }),
    then: (resolve: (value: unknown) => void) => {
      if (table !== "pour_events") {
        throw new Error(`Unexpected awaited table ${table}`);
      }
      resolve({ data: events, error: null });
    },
  };
  function track(method: string, args: unknown[]) {
    calls.push({ table, method, args });
    return chain;
  }
  return chain;
}

function makeServiceClient(options: Options, calls: Call[]) {
  return {
    from: vi.fn((table: string) => ({
      insert: (payload: unknown) => insert(table, payload, options, calls),
      delete: () => deleteChain(table, calls),
    })),
  };
}

function insert(table: string, payload: unknown, options: Options, calls: Call[]) {
  calls.push({ table, method: "insert", payload });
  if (table !== "bottle_closeouts") {
    return Promise.resolve({ error: options.finishError ?? null });
  }
  return {
    select: () => ({
      single: async () => ({
        data: options.closeoutError ? null : closeoutRow(),
        error: options.closeoutError ?? null,
      }),
    }),
  };
}

function closeoutRow() {
  return {
    id: "closeout-1",
    open_bottle_id: BOTTLE_ID,
    wine_id: WINE_ID,
    theoretical_remaining_ml: 600,
    actual_remaining_ml: 570,
    variance_ml: -30,
    written_off_ml: 30,
    reason_code_id: REASON_ID,
    preservation_method: "coravin",
  };
}

function deleteChain(table: string, calls: Call[]) {
  calls.push({ table, method: "delete", payload: null });
  const chain = {
    eq: (column: string, value: unknown) => {
      calls.push({ table, method: "eq", payload: [column, value] });
      return chain;
    },
    then: (resolve: (value: unknown) => void) => resolve({ error: null }),
  };
  return chain;
}

export function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/open-bottles/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
