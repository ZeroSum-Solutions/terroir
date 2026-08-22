import { describe, expect, it, vi } from "vitest";
import {
  markJobDeadImmediately,
  markJobRetryOrDead,
  markJobSucceeded,
} from "@/lib/jobs/complete";
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

/** Captures the update patch and the fencing .eq() chain applied to it. */
function makeSupabase(returnedRows: unknown[] | null, error: unknown = null) {
  const eqCalls: Array<[string, unknown]> = [];
  let capturedPatch: Record<string, unknown> | undefined;
  const chain: Record<string, unknown> = {};
  chain.eq = vi.fn((col: string, val: unknown) => {
    eqCalls.push([col, val]);
    return chain;
  });
  chain.select = vi.fn(async () => ({ data: returnedRows, error }));
  const update = vi.fn((patch: Record<string, unknown>) => {
    capturedPatch = patch;
    return chain;
  });
  const supabase = { from: vi.fn(() => ({ update })) };
  return {
    supabase,
    eqCalls,
    getPatch: () => capturedPatch,
  };
}

describe("fenced completion writes", () => {
  it("markJobSucceeded fences on id, restaurant_id, claimed_by, and status=processing", async () => {
    const { supabase, eqCalls, getPatch } = makeSupabase([{ id: "job-1" }]);
    const applied = await markJobSucceeded(supabase as never, baseJob());

    expect(applied).toBe(true);
    expect(getPatch()).toMatchObject({ status: "succeeded", error_code: null, error_message: null });
    expect(eqCalls).toEqual([
      ["id", "job-1"],
      ["restaurant_id", "restaurant-a"],
      ["claimed_by", "worker-1"],
      ["status", "processing"],
    ]);
  });

  it("markJobSucceeded returns false when fenced out (0 rows updated)", async () => {
    const { supabase } = makeSupabase([]);
    expect(await markJobSucceeded(supabase as never, baseJob())).toBe(false);
  });

  it("markJobRetryOrDead requeues with backoff when attempts remain", async () => {
    const { supabase, getPatch } = makeSupabase([{ id: "job-1" }]);
    const job = baseJob({ attemptCount: 0, maxAttempts: 3 });
    await markJobRetryOrDead(supabase as never, job, { code: "upstream_error", message: "boom" });

    const patch = getPatch()!;
    expect(patch.status).toBe("queued");
    expect(patch.attempt_count).toBe(1);
    expect(patch.claimed_at).toBeNull();
    expect(patch.claimed_by).toBeNull();
    expect(patch.error_code).toBe("upstream_error");
    expect(typeof patch.run_after).toBe("string");
    expect(new Date(patch.run_after as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("markJobRetryOrDead transitions to dead once max_attempts is exhausted", async () => {
    const { supabase, getPatch } = makeSupabase([{ id: "job-1" }]);
    const job = baseJob({ attemptCount: 2, maxAttempts: 3 });
    await markJobRetryOrDead(supabase as never, job, { code: "upstream_error", message: "boom" });

    const patch = getPatch()!;
    expect(patch.status).toBe("dead");
    expect(patch.attempt_count).toBe(3);
    expect(patch.finished_at).toBeDefined();
    expect(patch.run_after).toBeUndefined();
  });

  it("markJobDeadImmediately sets attempt_count to max_attempts and clears claim fields", async () => {
    const { supabase, getPatch } = makeSupabase([{ id: "job-1" }]);
    const job = baseJob({ attemptCount: 0, maxAttempts: 5 });
    await markJobDeadImmediately(supabase as never, job, {
      code: "tenant_mismatch_or_missing_subject",
      message: "nope",
    });

    const patch = getPatch()!;
    expect(patch.status).toBe("dead");
    expect(patch.attempt_count).toBe(5);
    expect(patch.claimed_at).toBeNull();
    expect(patch.claimed_by).toBeNull();
    expect(patch.error_code).toBe("tenant_mismatch_or_missing_subject");
  });

  it("throws on a database error instead of silently swallowing it", async () => {
    const dbError = { message: "connection reset" };
    const { supabase } = makeSupabase(null, dbError);
    await expect(markJobSucceeded(supabase as never, baseJob())).rejects.toBe(dbError);
  });
});
