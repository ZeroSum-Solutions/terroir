import { beforeEach, describe, expect, it, vi } from "vitest";

const { enrichWinesWithClaudeBatch, captureException, captureMessage } =
  vi.hoisted(() => ({
    enrichWinesWithClaudeBatch: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));

vi.mock("./enrich-claude", () => ({ enrichWinesWithClaudeBatch }));
vi.mock("@sentry/nextjs", () => ({ captureException, captureMessage }));

const { enrichRestaurantBatch } = await import("./batch");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_WINE = {
  id: WINE_ID,
  producer: "Private Producer",
  name: "Private Wine",
  varietal: "Unmapped grape",
  region: "Unmapped region",
  country: "Unmapped country",
  vintage: 2019,
  manual_overrides: [],
};
const RULE_WINE = {
  ...UNKNOWN_WINE,
  varietal: "Cabernet Sauvignon",
  region: "Napa Valley",
};

function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    then: (
      resolve: (value: typeof result) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ["select", "eq", "or", "limit", "in", "not", "is"]) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

function client(input: {
  queryResults: Array<{ data: unknown; error: unknown }>;
  rpc: ReturnType<typeof vi.fn>;
}) {
  const queryResults = [...input.queryResults];
  return {
    from: vi.fn(() => query(queryResults.shift() ?? { data: [], error: null })),
    rpc: input.rpc,
  };
}

function strictInput(supabase: unknown, signal?: AbortSignal) {
  return {
    supabase: supabase as never,
    restaurantId: RESTAURANT_ID,
    signal,
    strictWorkerExecution: true,
  };
}

describe("wine enrichment strict worker batch policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichWinesWithClaudeBatch.mockResolvedValue([null]);
  });

  it("rethrows a database fetch failure without exporting raw tenant data", async () => {
    const secretError = { message: "database-secret-body" };
    const supabase = client({
      queryResults: [{ data: null, error: secretError }],
      rpc: vi.fn(),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(enrichRestaurantBatch(strictInput(supabase))).rejects.toBe(
      secretError,
    );

    expect(consoleError).not.toHaveBeenCalled();
    const telemetry = JSON.stringify([
      captureException.mock.calls,
      captureMessage.mock.calls,
    ]);
    expect(telemetry).not.toContain(RESTAURANT_ID);
    expect(telemetry).not.toContain("database-secret-body");
  });

  it("rethrows a transient LWIN fallback failure instead of succeeding partially", async () => {
    const lwinError = { message: "catalog-secret-body" };
    const supabase = client({
      queryResults: [{ data: [UNKNOWN_WINE], error: null }],
      rpc: vi.fn().mockResolvedValue({ data: null, error: lwinError }),
    });

    await expect(enrichRestaurantBatch(strictInput(supabase))).rejects.toBe(
      lwinError,
    );

    const telemetry = JSON.stringify([
      captureException.mock.calls,
      captureMessage.mock.calls,
    ]);
    expect(telemetry).not.toContain(RESTAURANT_ID);
    expect(telemetry).not.toContain("catalog-secret-body");
  });

  it("observes an abort that occurs during the mutating LWIN RPC", async () => {
    const controller = new AbortController();
    const reason = new Error("lease-lost");
    const supabase = client({
      queryResults: [{ data: [UNKNOWN_WINE], error: null }],
      rpc: vi.fn().mockImplementation(async () => {
        controller.abort(reason);
        return { data: [], error: null };
      }),
    });

    await expect(
      enrichRestaurantBatch(strictInput(supabase, controller.signal)),
    ).rejects.toBe(reason);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("rethrows enrichment-write failures with aggregate-only telemetry", async () => {
    const writeError = { message: "write-secret-body" };
    const supabase = client({
      queryResults: [{ data: [RULE_WINE], error: null }],
      rpc: vi.fn().mockResolvedValue({ data: null, error: writeError }),
    });

    await expect(enrichRestaurantBatch(strictInput(supabase))).rejects.toBe(
      writeError,
    );

    const telemetry = JSON.stringify([
      captureException.mock.calls,
      captureMessage.mock.calls,
    ]);
    expect(telemetry).toContain("payloadSize");
    expect(telemetry).not.toContain(RESTAURANT_ID);
    expect(telemetry).not.toContain("write-secret-body");
  });
});
