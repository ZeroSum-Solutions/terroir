import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isStillClaimed, renewClaim, withClaimHeartbeat } from "@/lib/jobs/heartbeat";
import type { ClaimedInvoiceExtractJob } from "@/lib/jobs/types";

function baseJob(overrides: Partial<ClaimedInvoiceExtractJob> = {}): ClaimedInvoiceExtractJob {
  return {
    id: "job-1",
    restaurantId: "restaurant-a",
    createdBy: null,
    subjectId: "scan-1",
    attemptCount: 0,
    maxAttempts: 3,
    claimedBy: "worker-1",
    ...overrides,
  };
}

describe("renewClaim", () => {
  it("fences on id, restaurant_id, claimed_by, and status=processing", async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return chain;
    });
    chain.select = vi.fn(async () => ({ data: [{ id: "job-1" }], error: null }));
    const supabase = { from: vi.fn(() => ({ update: vi.fn(() => chain) })) };

    const renewed = await renewClaim(supabase as never, baseJob());

    expect(renewed).toBe(true);
    expect(eqCalls).toEqual([
      ["id", "job-1"],
      ["restaurant_id", "restaurant-a"],
      ["claimed_by", "worker-1"],
      ["status", "processing"],
    ]);
  });

  it("returns false when the fenced update affects no rows (lease already lost)", async () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(async () => ({ data: [], error: null }));
    const supabase = { from: vi.fn(() => ({ update: vi.fn(() => chain) })) };

    expect(await renewClaim(supabase as never, baseJob())).toBe(false);
  });

  it("throws on a database error", async () => {
    const dbError = { message: "connection reset" };
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(async () => ({ data: null, error: dbError }));
    const supabase = { from: vi.fn(() => ({ update: vi.fn(() => chain) })) };

    await expect(renewClaim(supabase as never, baseJob())).rejects.toBe(dbError);
  });
});

describe("isStillClaimed", () => {
  function supabaseWith(row: unknown, error: unknown = null) {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: row, error }));
    return { from: vi.fn(() => ({ select: vi.fn(() => chain) })) };
  }

  it("returns true when the fenced read finds the job still owned by this worker", async () => {
    expect(await isStillClaimed(supabaseWith({ id: "job-1" }) as never, baseJob())).toBe(true);
  });

  it("returns false when the fenced read finds nothing (reclaimed by someone else)", async () => {
    expect(await isStillClaimed(supabaseWith(null) as never, baseJob())).toBe(false);
  });

  it("throws on a database error", async () => {
    const dbError = { message: "boom" };
    await expect(isStillClaimed(supabaseWith(null, dbError) as never, baseJob())).rejects.toBe(dbError);
  });
});

describe("withClaimHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews the claim on an interval while work is in flight, and stops once work resolves", async () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(async () => ({ data: [{ id: "job-1" }], error: null }));
    const update = vi.fn(() => chain);
    const supabase = { from: vi.fn(() => ({ update })) };

    let resolveWork!: (value: string) => void;
    const work = () => new Promise<string>((resolve) => { resolveWork = resolve; });

    const promise = withClaimHeartbeat(supabase as never, baseJob(), 1_000, work);

    await vi.advanceTimersByTimeAsync(3_500);
    expect(update).toHaveBeenCalledTimes(3);

    resolveWork("done");
    await expect(promise).resolves.toBe("done");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledTimes(3); // no further ticks after work resolved
  });

  it("propagates work's rejection and still stops the heartbeat", async () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(async () => ({ data: [{ id: "job-1" }], error: null }));
    const update = vi.fn(() => chain);
    const supabase = { from: vi.fn(() => ({ update })) };

    const boom = new Error("extraction threw");
    const promise = withClaimHeartbeat(supabase as never, baseJob(), 1_000, () => Promise.reject(boom));

    await expect(promise).rejects.toBe(boom);
    const callsAtFailure = update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledTimes(callsAtFailure);
  });

  it("a failed renewal (lease already lost) does not throw or interrupt work", async () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(async () => ({ data: [], error: null })); // fenced out every tick
    const supabase = { from: vi.fn(() => ({ update: vi.fn(() => chain) })) };

    let resolveWork!: (value: string) => void;
    const work = () => new Promise<string>((resolve) => { resolveWork = resolve; });
    const promise = withClaimHeartbeat(supabase as never, baseJob(), 1_000, work);

    await vi.advanceTimersByTimeAsync(2_000);
    resolveWork("done");
    await expect(promise).resolves.toBe("done");
  });
});
