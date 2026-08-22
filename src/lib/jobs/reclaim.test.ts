import { describe, expect, it, vi } from "vitest";
import { reclaimStuckInvoiceExtractJobs } from "@/lib/jobs/reclaim";

describe("reclaimStuckInvoiceExtractJobs", () => {
  it("passes the stuck threshold through and returns the reclaimed count", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({ data: [{ id: "job-1" }, { id: "job-2" }], error: null })),
    };
    const count = await reclaimStuckInvoiceExtractJobs(supabase as never, 300);
    expect(count).toBe(2);
    expect(supabase.rpc).toHaveBeenCalledWith("reclaim_stuck_invoice_extract_jobs", {
      p_stuck_after_seconds: 300,
    });
  });

  it("returns 0 when nothing was stuck", async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: [], error: null })) };
    expect(await reclaimStuckInvoiceExtractJobs(supabase as never, 300)).toBe(0);
  });

  it("throws when the RPC errors", async () => {
    const rpcError = { message: "boom" };
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: rpcError })) };
    await expect(reclaimStuckInvoiceExtractJobs(supabase as never, 300)).rejects.toBe(rpcError);
  });
});
