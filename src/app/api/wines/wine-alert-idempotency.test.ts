import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({
  requireCapability: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireCapability(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: DISMISS } = await import(
  "./[id]/dismiss-pricing-alert/route"
);
const { POST: OVERPAID } = await import("./[id]/overpaid/route");
const { PATCH: TARGETS } = await import("./[id]/pricing-targets/route");
const { POST: SNOOZE } = await import("./[id]/snooze-alert/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "wine-alert-command-key-0001";
const DISMISSED_UNTIL = "2026-08-23T12:34:56.789Z";
const SNOOZED_UNTIL = "2026-08-24T01:02:03.456Z";

function request(
  path: string,
  method: string,
  body?: unknown,
  key?: string,
) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (key) headers.set("Idempotency-Key", key);
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ id: WINE_ID }) };
}

function allow(supabase: {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
}) {
  auth.requireCapability.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
}

function replayBody(operationId: string): unknown {
  switch (operationId) {
    case "api:PATCH:/api/wines/{param}/pricing-targets":
      return {
        wineId: WINE_ID,
        pour_cost_pct: null,
        markup_ratio: 2.5,
      };
    case "api:POST:/api/wines/{param}/dismiss-pricing-alert":
      return {
        wineId: WINE_ID,
        dismissedUntil: DISMISSED_UNTIL,
        days: 30,
      };
    case "api:POST:/api/wines/{param}/snooze-alert":
      return {
        wineId: WINE_ID,
        snoozedUntil: SNOOZED_UNTIL,
        days: 30,
      };
    case "api:POST:/api/wines/{param}/overpaid":
      return { wineId: WINE_ID, overpaid_flag: true };
    default:
      throw new Error(`Unexpected operation ${operationId}`);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("wine alert mutation idempotency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds every route to all normalized input and replays exact timestamps", async () => {
    const claims: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        if (name !== "claim_api_idempotency") {
          throw new Error(`Unexpected RPC ${name}`);
        }
        claims.push(args);
        return {
          data: [
            {
              outcome: "replay",
              response_status: 200,
              response_body: replayBody(String(args.p_operation_id)),
              response_headers: {},
            },
          ],
          error: null,
        };
      },
    );
    const from = vi.fn(() => {
      throw new Error("replays must not execute business work");
    });
    allow({ from, rpc });

    const targets = await TARGETS(
      request(
        `/api/wines/${WINE_ID}/pricing-targets`,
        "PATCH",
        { markup_ratio: 2.5, pour_cost_pct: null },
        `${KEY}-targets`,
      ),
      params(),
    );
    const dismissDefault = await DISMISS(
      request(
        `/api/wines/${WINE_ID}/dismiss-pricing-alert`,
        "POST",
        {},
        `${KEY}-dismiss-default`,
      ),
      params(),
    );
    const dismissExplicit = await DISMISS(
      request(
        `/api/wines/${WINE_ID}/dismiss-pricing-alert`,
        "POST",
        { days: 30 },
        `${KEY}-dismiss-explicit`,
      ),
      params(),
    );
    const snooze = await SNOOZE(
      request(
        `/api/wines/${WINE_ID}/snooze-alert`,
        "POST",
        {},
        `${KEY}-snooze`,
      ),
      params(),
    );
    const overpaid = await OVERPAID(
      request(
        `/api/wines/${WINE_ID}/overpaid`,
        "POST",
        undefined,
        `${KEY}-overpaid`,
      ),
      params(),
    );

    expect(await targets.json()).toEqual(
      replayBody("api:PATCH:/api/wines/{param}/pricing-targets"),
    );
    expect(await dismissDefault.json()).toEqual(
      replayBody(
        "api:POST:/api/wines/{param}/dismiss-pricing-alert",
      ),
    );
    expect(await dismissExplicit.json()).toEqual(
      replayBody(
        "api:POST:/api/wines/{param}/dismiss-pricing-alert",
      ),
    );
    expect(await snooze.json()).toEqual(
      replayBody("api:POST:/api/wines/{param}/snooze-alert"),
    );
    expect(await overpaid.json()).toEqual(
      replayBody("api:POST:/api/wines/{param}/overpaid"),
    );
    for (const response of [
      targets,
      dismissDefault,
      dismissExplicit,
      snooze,
      overpaid,
    ]) {
      expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    }
    expect(from).not.toHaveBeenCalled();
    expect(claims).toEqual([
      expect.objectContaining({
        p_operation_id:
          "api:PATCH:/api/wines/{param}/pricing-targets",
        p_request_hash: createIdempotencyRequestHash({
          id: WINE_ID,
          body: { markup_ratio: 2.5, pour_cost_pct: null },
        }),
      }),
      expect.objectContaining({
        p_operation_id:
          "api:POST:/api/wines/{param}/dismiss-pricing-alert",
        p_request_hash: createIdempotencyRequestHash({
          id: WINE_ID,
          body: { days: 30 },
        }),
      }),
      expect.objectContaining({
        p_operation_id:
          "api:POST:/api/wines/{param}/dismiss-pricing-alert",
        p_request_hash: createIdempotencyRequestHash({
          id: WINE_ID,
          body: { days: 30 },
        }),
      }),
      expect.objectContaining({
        p_operation_id: "api:POST:/api/wines/{param}/snooze-alert",
        p_request_hash: createIdempotencyRequestHash({
          id: WINE_ID,
          body: { days: 30 },
        }),
      }),
      expect.objectContaining({
        p_operation_id: "api:POST:/api/wines/{param}/overpaid",
        p_request_hash: createIdempotencyRequestHash({ id: WINE_ID }),
      }),
    ]);
  });

  it("serializes a concurrent overpaid toggle and replays one exact flip", async () => {
    const lookup = deferred<{
      data: { id: string; overpaid_flag: boolean };
      error: null;
    }>();
    let state: "empty" | "in_progress" | "completed" = "empty";
    let completedBody: unknown = null;
    const rpc = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "claim_api_idempotency") {
          if (state === "empty") {
            state = "in_progress";
            return {
              data: [{
                outcome: "claimed",
                response_status: null,
                response_body: null,
                response_headers: null,
              }],
              error: null,
            };
          }
          if (state === "in_progress") {
            return {
              data: [{
                outcome: "in_progress",
                response_status: null,
                response_body: null,
                response_headers: null,
              }],
              error: null,
            };
          }
          return {
            data: [{
              outcome: "replay",
              response_status: 200,
              response_body: completedBody,
              response_headers: {},
            }],
            error: null,
          };
        }
        if (name === "complete_api_idempotency") {
          state = "completed";
          completedBody = args.p_response_body;
          return { data: true, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    );
    let fromCalls = 0;
    const from = vi.fn(() => {
      fromCalls += 1;
      const result =
        fromCalls === 1
          ? lookup.promise
          : Promise.resolve({ data: { id: WINE_ID }, error: null });
      const chain = {
        select: () => chain,
        update: (payload: unknown) => {
          expect(payload).toEqual({ overpaid_flag: true });
          return chain;
        },
        eq: () => chain,
        maybeSingle: () => result,
      };
      return chain;
    });
    allow({ from, rpc });

    const first = OVERPAID(
      request(
        `/api/wines/${WINE_ID}/overpaid`,
        "POST",
        undefined,
        KEY,
      ),
      params(),
    );
    await vi.waitFor(() => expect(from).toHaveBeenCalledTimes(1));

    const concurrent = await OVERPAID(
      request(
        `/api/wines/${WINE_ID}/overpaid`,
        "POST",
        undefined,
        KEY,
      ),
      params(),
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({
      error: { code: "idempotency_in_progress" },
    });
    expect(from).toHaveBeenCalledTimes(1);

    lookup.resolve({
      data: { id: WINE_ID, overpaid_flag: false },
      error: null,
    });
    const completed = await first;
    expect(await completed.json()).toEqual({
      wineId: WINE_ID,
      overpaid_flag: true,
    });
    expect(from).toHaveBeenCalledTimes(2);

    const replay = await OVERPAID(
      request(
        `/api/wines/${WINE_ID}/overpaid`,
        "POST",
        undefined,
        KEY,
      ),
      params(),
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual({
      wineId: WINE_ID,
      overpaid_flag: true,
    });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed key before wine work or idempotency storage", async () => {
    const from = vi.fn();
    const rpc = vi.fn();
    allow({ from, rpc });

    const response = await TARGETS(
      request(
        `/api/wines/${WINE_ID}/pricing-targets`,
        "PATCH",
        { markup_ratio: 2.5 },
        "bad key!",
      ),
      params(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
