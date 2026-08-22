import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProcessInvoiceScanOnce = vi.fn();
vi.mock("@/domains/scanning/invoice-scan-service", () => ({
  processInvoiceScanOnce: (...args: unknown[]) => mockProcessInvoiceScanOnce(...args),
}));

const { runInvoiceExtractJob } = await import("@/lib/jobs/invoice-extract-handler");
import type { ClaimedInvoiceExtractJob } from "@/lib/jobs/types";

function job(overrides: Partial<ClaimedInvoiceExtractJob> = {}): ClaimedInvoiceExtractJob {
  return {
    id: "job-1",
    restaurantId: "restaurant-a",
    createdBy: null,
    subjectId: "scan-1",
    attemptCount: 0,
    maxAttempts: 5,
    claimedBy: "worker-1",
    ...overrides,
  };
}

function supabaseFor(opts: {
  scan?: Record<string, unknown> | null;
  fetchError?: unknown;
  downloadData?: unknown;
  downloadError?: unknown;
  /** Whether the background_jobs claim-check (isStillClaimed) finds this worker still owns the job. Default true. */
  stillClaimed?: boolean;
}) {
  const {
    scan = null,
    fetchError = null,
    downloadData = null,
    downloadError = null,
    stillClaimed = true,
  } = opts;
  return {
    from: vi.fn((table: string) => {
      if (table === "invoice_scans") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: scan, error: fetchError })),
              })),
            })),
          })),
        };
      }
      if (table === "background_jobs") {
        // isStillClaimed's fencing read: id + restaurant_id + claimed_by + status.
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: stillClaimed ? { id: "job-1" } : null,
                      error: null,
                    })),
                  })),
                })),
              })),
            })),
          })),
        };
      }
      throw new Error(`unexpected table in test mock: ${table}`);
    }),
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async () => ({ data: downloadData, error: downloadError })),
      })),
    },
  };
}

const validScan = {
  id: "scan-1",
  status: "processing",
  raw_image_path: "restaurant-a/x.jpg",
  created_by: "user-1",
};

const fakeBlob = { arrayBuffer: async () => new TextEncoder().encode("bytes").buffer };

describe("runInvoiceExtractJob", () => {
  beforeEach(() => {
    mockProcessInvoiceScanOnce.mockReset();
  });

  it("dies immediately when the job has no subject_id", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({}) as never,
      job: job({ subjectId: null }),
    });
    expect(outcome.kind).toBe("dead");
    expect((outcome as { code: string }).code).toBe("missing_subject");
  });

  it("dies when no scan is found scoped to the job's restaurant_id (tenant mismatch or missing row)", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: null }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("dead");
    expect((outcome as { code: string }).code).toBe("tenant_mismatch_or_missing_subject");
    expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
  });

  it("retries when the tenant-scoped fetch itself errors (transient)", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ fetchError: { message: "connection reset" } }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("retry");
    expect((outcome as { code: string }).code).toBe("subject_fetch_failed");
  });

  it("succeeds without calling the extraction service when the scan is already complete (no double-bill)", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: { ...validScan, status: "complete" } }) as never,
      job: job(),
    });
    expect(outcome).toEqual({ kind: "succeeded", skippedExtraction: true });
    expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
  });

  it("succeeds without calling the extraction service when the scan is already in review (G1-12 arithmetic-mismatch outcome, no double-bill)", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: { ...validScan, status: "review" } }) as never,
      job: job(),
    });
    expect(outcome).toEqual({ kind: "succeeded", skippedExtraction: true });
    expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
  });

  it("dies when raw_image_path is missing", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: { ...validScan, raw_image_path: null } }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("dead");
    expect((outcome as { code: string }).code).toBe("missing_or_mistenanted_image_path");
  });

  it("dies when raw_image_path is not scoped to the job's restaurant (defense in depth)", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: { ...validScan, raw_image_path: "restaurant-b/x.jpg" } }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("dead");
    expect((outcome as { code: string }).code).toBe("missing_or_mistenanted_image_path");
    expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
  });

  it("dies on an unsupported file extension", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: { ...validScan, raw_image_path: "restaurant-a/x.bmp" } }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("dead");
    expect((outcome as { code: string }).code).toBe("unsupported_extension");
  });

  it("retries on a storage download failure", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: validScan, downloadError: { message: "storage unavailable" } }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("retry");
    expect((outcome as { code: string }).code).toBe("image_download_failed");
  });

  it("aborts WITHOUT calling the extraction service when the claim was lost before extraction started (closes the double-bill window)", async () => {
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: validScan, downloadData: fakeBlob, stillClaimed: false }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("retry");
    expect((outcome as { code: string }).code).toBe("claim_lost_before_extraction");
    expect(mockProcessInvoiceScanOnce).not.toHaveBeenCalled();
  });

  it("succeeds when the extraction service returns 200, calling it with the pre-created scan", async () => {
    mockProcessInvoiceScanOnce.mockResolvedValue({ status: 200, body: { scanId: "scan-1" } });
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: validScan, downloadData: fakeBlob }) as never,
      job: job(),
    });
    expect(outcome).toEqual({ kind: "succeeded", skippedExtraction: false });
    expect(mockProcessInvoiceScanOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurantId: "restaurant-a",
        preCreatedScanId: "scan-1",
        preUploadedPath: "restaurant-a/x.jpg",
        mimeType: "image/jpeg",
        userId: "user-1",
      }),
    );
  });

  it.each([
    ["upstream_error", 502, "retry"],
    ["rate_limited", 429, "retry"],
    ["parse_failed", 422, "dead"],
    ["validation_failed", 422, "dead"],
    ["no_wines_extracted", 422, "dead"],
    ["bad_input", 400, "dead"],
  ] as const)("classifies extraction code %s (status %d) as %s", async (code, status, expectedKind) => {
    mockProcessInvoiceScanOnce.mockResolvedValue({ status, body: { code, message: "boom" } });
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: validScan, downloadData: fakeBlob }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe(expectedKind);
  });

  it("retries any 5xx even with an unrecognized code", async () => {
    mockProcessInvoiceScanOnce.mockResolvedValue({ status: 503, body: {} });
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: validScan, downloadData: fakeBlob }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("retry");
  });

  it("retries when the extraction service throws", async () => {
    mockProcessInvoiceScanOnce.mockRejectedValue(new Error("network blip"));
    const outcome = await runInvoiceExtractJob({
      supabase: supabaseFor({ scan: validScan, downloadData: fakeBlob }) as never,
      job: job(),
    });
    expect(outcome.kind).toBe("retry");
    expect((outcome as { code: string }).code).toBe("extraction_threw");
  });
});
