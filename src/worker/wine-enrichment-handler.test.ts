import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobExecutionError } from "./errors.ts";
import { createWineEnrichmentJobHandler } from "./wine-enrichment-handler.ts";
import type { BackgroundJob } from "./types.ts";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    job_type: "wine_enrichment",
    attempt_count: 1,
    max_attempts: 3,
    lease_token: "lease",
    metadata: { scope: "restaurant" },
    restaurant_id: RESTAURANT_ID,
    subject_id: RESTAURANT_ID,
    subject_table: "restaurants",
    status: "running",
    ...overrides,
  };
}

describe("wine-enrichment worker handler", () => {
  const enrichRestaurant = vi.fn();
  const enrichSingle = vi.fn();
  const supabase = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    enrichRestaurant.mockResolvedValue({
      total: 2,
      enriched: 2,
      ruleEnrichedCount: 2,
      claudeEnrichedCount: 0,
      claudeAttemptedCount: 0,
      claudeRemaining: 0,
      lwinFallbackCount: 0,
      lwinMatched: 0,
      hasMore: false,
    });
    enrichSingle.mockResolvedValue({
      status: 200,
      body: { wineId: WINE_ID, source: "rule_engine" },
    });
  });

  function handler() {
    return createWineEnrichmentJobHandler(supabase, {
      enrichRestaurant,
      enrichSingle,
    });
  }

  it("runs a tenant-wide enrichment through the durable job scope", async () => {
    await expect(
      handler()(job(), new AbortController().signal),
    ).resolves.toMatchObject({
      scope: "restaurant",
      total: 2,
      enriched: 2,
      has_more: false,
    });
    expect(enrichRestaurant).toHaveBeenCalledWith({
      supabase,
      restaurantId: RESTAURANT_ID,
      signal: expect.any(AbortSignal),
      strictWorkerExecution: true,
    });
  });

  it("runs a tenant-bound single-wine enrichment", async () => {
    const singleJob = job({
      metadata: { scope: "wine" },
      subject_id: WINE_ID,
      subject_table: "wines",
    });

    await expect(
      handler()(singleJob, new AbortController().signal),
    ).resolves.toEqual({
      scope: "wine",
      wine_id: WINE_ID,
      source: "rule_engine",
    });
    expect(enrichSingle).toHaveBeenCalledWith({
      supabase,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      signal: expect.any(AbortSignal),
      throwOnProviderFailure: true,
    });
  });

  it.each([
    { job_type: "invoice_ocr" },
    { restaurant_id: "not-a-uuid" },
    { subject_table: "wines" },
    { subject_id: WINE_ID },
    { metadata: { scope: "restaurant", extra: true } },
  ])("rejects malformed or cross-scope input before business work: %o", async (override) => {
    await expect(
      handler()(job(override), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "invalid_wine_enrichment_job_payload",
      retryable: false,
    });
    expect(enrichRestaurant).not.toHaveBeenCalled();
    expect(enrichSingle).not.toHaveBeenCalled();
  });

  it("honors a worker abort before any provider or database effect", async () => {
    const controller = new AbortController();
    const reason = new JobExecutionError(
      "worker_shutdown",
      true,
      "Worker is shutting down",
    );
    controller.abort(reason);

    await expect(handler()(job(), controller.signal)).rejects.toBe(reason);
    expect(enrichRestaurant).not.toHaveBeenCalled();
  });

  it("maps a transient business failure to a retryable safe error", async () => {
    enrichRestaurant.mockResolvedValue({
      error: "Failed to fetch wines.",
      status: 500,
    });

    await expect(
      handler()(job(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "wine_enrichment_failed",
      retryable: true,
    });
  });

  it("treats a deleted single-wine subject as terminal", async () => {
    enrichSingle.mockResolvedValue({
      status: 404,
      body: { error: { code: "not_found", message: "Wine not found." } },
    });

    await expect(
      handler()(
        job({
          metadata: { scope: "wine" },
          subject_id: WINE_ID,
          subject_table: "wines",
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "wine_enrichment_subject_not_found",
      retryable: false,
    });
  });

  it("converges duplicate delivery without multiplying stored wine rows", async () => {
    let storedRows = 0;
    enrichRestaurant.mockImplementation(async () => {
      const newlyStored = storedRows === 0 ? 2 : 0;
      storedRows += newlyStored;
      return {
        total: newlyStored,
        enriched: newlyStored,
        ruleEnrichedCount: newlyStored,
        claudeEnrichedCount: 0,
        claudeAttemptedCount: 0,
        claudeRemaining: 0,
        lwinFallbackCount: 0,
        lwinMatched: 0,
        hasMore: false,
      };
    });

    await handler()(job(), new AbortController().signal);
    await handler()(job(), new AbortController().signal);

    expect(storedRows).toBe(2);
  });
});
