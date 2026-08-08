import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireCapability: vi.fn() }));
const services = vi.hoisted(() => ({
  enrichRestaurantBatch: vi.fn(),
  enrichSingleWine: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireCapability: (...args: unknown[]) =>
    auth.requireCapability(...args),
}));
vi.mock("@/lib/wine-intelligence/batch", () => ({
  enrichRestaurantBatch: (...args: unknown[]) =>
    services.enrichRestaurantBatch(...args),
}));
vi.mock("@/lib/wine-intelligence/single", () => ({
  enrichSingleWine: (...args: unknown[]) => services.enrichSingleWine(...args),
}));

const { POST: ENRICH_BATCH } = await import("./enrich/route");
const { POST: ENRICH_SINGLE } = await import("./[id]/enrich/route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function request(path: string, key?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: key ? { "Idempotency-Key": key } : undefined,
  });
}

function wineQuery() {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: { id: WINE_ID }, error: null })),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

function authenticate() {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "claim_api_idempotency") {
      return { data: [{ outcome: "claimed" }], error: null };
    }
    if (fn === "enqueue_background_job") {
      return { data: { id: JOB_ID, status: "queued" }, error: null };
    }
    if (fn === "complete_api_idempotency") {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${fn}`);
  });
  const query = wineQuery();
  const supabase = { from: vi.fn(() => query), rpc };
  auth.requireCapability.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
  return { query, rpc };
}

describe("wine-enrichment worker route rollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WINE_ENRICHMENT_WORKER_ENABLED;
    services.enrichRestaurantBatch.mockResolvedValue({
      total: 0,
      enriched: 0,
      ruleEnrichedCount: 0,
      claudeEnrichedCount: 0,
      claudeAttemptedCount: 0,
      claudeRemaining: 0,
      lwinFallbackCount: 0,
      lwinMatched: 0,
      hasMore: false,
    });
    services.enrichSingleWine.mockResolvedValue({
      status: 200,
      body: { wineId: WINE_ID, source: "rule_engine" },
    });
  });

  afterEach(() => {
    delete process.env.WINE_ENRICHMENT_WORKER_ENABLED;
  });

  it("keeps both enrichment routes synchronous while the flag is absent", async () => {
    authenticate();
    const batch = await ENRICH_BATCH(request("/api/wines/enrich"));
    expect(batch.status).toBe(200);
    expect(services.enrichRestaurantBatch).toHaveBeenCalledOnce();

    authenticate();
    const single = await ENRICH_SINGLE(
      request(`/api/wines/${WINE_ID}/enrich`),
      { params: Promise.resolve({ id: WINE_ID }) },
    );
    expect(single.status).toBe(200);
    expect(services.enrichSingleWine).toHaveBeenCalledOnce();
  });

  it("requires a retry-stable key before an enabled enqueue", async () => {
    process.env.WINE_ENRICHMENT_WORKER_ENABLED = "1";
    const { rpc } = authenticate();

    const response = await ENRICH_BATCH(request("/api/wines/enrich"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(services.enrichRestaurantBatch).not.toHaveBeenCalled();
  });

  it("returns one durable tenant-wide job without synchronous provider work", async () => {
    process.env.WINE_ENRICHMENT_WORKER_ENABLED = "1";
    const { rpc } = authenticate();

    const response = await ENRICH_BATCH(
      request("/api/wines/enrich", "enrich-batch-0001"),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({ jobId: JOB_ID, status: "queued" });
    expect(services.enrichRestaurantBatch).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_background_job",
      expect.objectContaining({
        p_job_type: "wine_enrichment",
        p_subject_table: "restaurants",
        p_subject_id: RESTAURANT_ID,
      }),
    );
  });

  it("tenant-checks and enqueues one wine without synchronous provider work", async () => {
    process.env.WINE_ENRICHMENT_WORKER_ENABLED = "1";
    const { query, rpc } = authenticate();

    const response = await ENRICH_SINGLE(
      request(`/api/wines/${WINE_ID}/enrich`, "enrich-wine-0001"),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: JOB_ID, status: "queued" });
    expect(query.eq).toHaveBeenCalledWith("restaurant_id", RESTAURANT_ID);
    expect(services.enrichSingleWine).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_background_job",
      expect.objectContaining({
        p_subject_table: "wines",
        p_subject_id: WINE_ID,
      }),
    );
  });
});
