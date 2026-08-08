import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueWineEnrichmentJob,
  WineEnrichmentJobConflictError,
  WineEnrichmentSubjectNotFoundError,
} from "./wine-enrichment-job-service";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function query(result: unknown) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

describe("wine-enrichment job service", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({
      data: { id: JOB_ID, status: "queued" },
      error: null,
    });
  });

  it("enqueues one tenant-wide job with a stable subject and retry key", async () => {
    const supabase = { from: vi.fn(), rpc } as never;

    await expect(
      enqueueWineEnrichmentJob({
        supabase,
        restaurantId: RESTAURANT_ID,
        idempotencyKey: "enrich-batch-0001",
      }),
    ).resolves.toEqual({ id: JOB_ID, status: "queued" });
    expect(rpc).toHaveBeenCalledWith("enqueue_background_job", {
      p_restaurant_id: RESTAURANT_ID,
      p_job_type: "wine_enrichment",
      p_idempotency_key: "enrich-batch-0001",
      p_subject_table: "restaurants",
      p_subject_id: RESTAURANT_ID,
      p_metadata: { scope: "restaurant" },
      p_max_attempts: 3,
    });
  });

  it("tenant-checks a single wine before enqueueing its durable job", async () => {
    const wineQuery = query({ data: { id: WINE_ID }, error: null });
    const supabase = {
      from: vi.fn(() => wineQuery),
      rpc,
    } as never;

    await enqueueWineEnrichmentJob({
      supabase,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      idempotencyKey: "enrich-wine-0001",
    });

    expect(wineQuery.eq).toHaveBeenCalledWith("restaurant_id", RESTAURANT_ID);
    expect(rpc).toHaveBeenCalledWith(
      "enqueue_background_job",
      expect.objectContaining({
        p_subject_table: "wines",
        p_subject_id: WINE_ID,
        p_metadata: { scope: "wine" },
      }),
    );
  });

  it("does not enqueue a missing or cross-tenant single wine", async () => {
    const supabase = {
      from: vi.fn(() => query({ data: null, error: null })),
      rpc,
    } as never;

    await expect(
      enqueueWineEnrichmentJob({
        supabase,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        idempotencyKey: "enrich-wine-0001",
      }),
    ).rejects.toBeInstanceOf(WineEnrichmentSubjectNotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifies only the durable input mismatch as an enqueue conflict", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "22023",
        message: "idempotency key was reused with different job input",
      },
    });
    const supabase = { from: vi.fn(), rpc } as never;

    await expect(
      enqueueWineEnrichmentJob({
        supabase,
        restaurantId: RESTAURANT_ID,
        idempotencyKey: "enrich-batch-0001",
      }),
    ).rejects.toBeInstanceOf(WineEnrichmentJobConflictError);
  });
});
