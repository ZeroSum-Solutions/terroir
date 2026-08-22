import { describe, expect, it, vi } from "vitest";
import { claimNextInvoiceExtractJob } from "@/lib/jobs/claim";

describe("claimNextInvoiceExtractJob", () => {
  it("returns null when the RPC finds nothing to claim", async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: [], error: null })) };
    const result = await claimNextInvoiceExtractJob(supabase as never, "worker-1");
    expect(result).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith("claim_invoice_extract_job", {
      p_worker_id: "worker-1",
    });
  });

  it("maps the claimed row to a ClaimedInvoiceExtractJob", async () => {
    const row = {
      id: "job-1",
      restaurant_id: "restaurant-a",
      created_by: "user-1",
      subject_id: "scan-1",
      attempt_count: 2,
      max_attempts: 5,
      claimed_by: "worker-1",
    };
    const supabase = { rpc: vi.fn(async () => ({ data: [row], error: null })) };
    const result = await claimNextInvoiceExtractJob(supabase as never, "worker-1");
    expect(result).toEqual({
      id: "job-1",
      restaurantId: "restaurant-a",
      createdBy: "user-1",
      subjectId: "scan-1",
      attemptCount: 2,
      maxAttempts: 5,
      claimedBy: "worker-1",
    });
  });

  it("throws when the RPC errors", async () => {
    const rpcError = { message: "connection lost" };
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: rpcError })) };
    await expect(claimNextInvoiceExtractJob(supabase as never, "worker-1")).rejects.toBe(rpcError);
  });
});
