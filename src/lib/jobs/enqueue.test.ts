import { describe, expect, it, vi } from "vitest";
import { enqueueInvoiceExtractJob } from "@/lib/jobs/enqueue";

/**
 * C20 (db audit 2026-08-23): enqueueInvoiceExtractJob is now a thin wrapper
 * around the `enqueue_invoice_extract_job` SECURITY DEFINER RPC — the
 * membership check, subject-ownership check, idempotency-key pinning, and
 * dead-job revival all moved server-side (see
 * supabase/migrations/0083_background_jobs_enqueue_rpc.sql). These tests
 * only cover the TS wrapper's own job: calling the RPC with the right
 * params and mapping its result/errors.
 */
describe("enqueueInvoiceExtractJob", () => {
  it("calls enqueue_invoice_extract_job with the right params and maps a new job", async () => {
    const single = vi.fn(async () => ({
      data: { job_id: "job-1", created: true },
      error: null,
    }));
    const rpc = vi.fn(() => ({ single }));
    const supabase = { rpc };

    const result = await enqueueInvoiceExtractJob({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      scanId: "scan-1",
    });

    expect(rpc).toHaveBeenCalledWith("enqueue_invoice_extract_job", {
      p_restaurant_id: "restaurant-a",
      p_scan_id: "scan-1",
    });
    expect(result).toEqual({ jobId: "job-1", created: true });
  });

  it("maps created:false when the RPC returns an existing or revived job", async () => {
    const single = vi.fn(async () => ({
      data: { job_id: "job-existing", created: false },
      error: null,
    }));
    const supabase = { rpc: vi.fn(() => ({ single })) };

    const result = await enqueueInvoiceExtractJob({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      scanId: "scan-1",
    });

    expect(result).toEqual({ jobId: "job-existing", created: false });
  });

  it("rethrows an RPC error (e.g. forbidden or subject-not-found)", async () => {
    const rpcError = { code: "42501", message: "forbidden" };
    const single = vi.fn(async () => ({ data: null, error: rpcError }));
    const supabase = { rpc: vi.fn(() => ({ single })) };

    await expect(
      enqueueInvoiceExtractJob({
        supabase: supabase as never,
        restaurantId: "restaurant-a",
        scanId: "scan-1",
      }),
    ).rejects.toBe(rpcError);
  });
});
