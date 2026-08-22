import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClaim = vi.fn();
const mockRun = vi.fn();
const mockMarkSucceeded = vi.fn();
const mockMarkRetryOrDead = vi.fn();
const mockMarkDeadImmediately = vi.fn();

vi.mock("@/lib/jobs/claim", () => ({
  claimNextInvoiceExtractJob: (...args: unknown[]) => mockClaim(...args),
}));
vi.mock("@/lib/jobs/invoice-extract-handler", () => ({
  runInvoiceExtractJob: (...args: unknown[]) => mockRun(...args),
}));
vi.mock("@/lib/jobs/complete", () => ({
  markJobSucceeded: (...args: unknown[]) => mockMarkSucceeded(...args),
  markJobRetryOrDead: (...args: unknown[]) => mockMarkRetryOrDead(...args),
  markJobDeadImmediately: (...args: unknown[]) => mockMarkDeadImmediately(...args),
}));

const { processOneInvoiceExtractJob } = await import("@/lib/jobs/run-once");

const job = {
  id: "job-1",
  restaurantId: "restaurant-a",
  createdBy: null,
  subjectId: "scan-1",
  attemptCount: 0,
  maxAttempts: 5,
  claimedBy: "worker-1",
};

describe("processOneInvoiceExtractJob", () => {
  beforeEach(() => {
    mockClaim.mockReset();
    mockRun.mockReset();
    mockMarkSucceeded.mockReset();
    mockMarkRetryOrDead.mockReset();
    mockMarkDeadImmediately.mockReset();
  });

  it("returns processed:false without running or completing anything when the queue is empty", async () => {
    mockClaim.mockResolvedValue(null);
    const result = await processOneInvoiceExtractJob({} as never, "worker-1");
    expect(result).toEqual({ processed: false });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("routes a succeeded outcome to markJobSucceeded", async () => {
    mockClaim.mockResolvedValue(job);
    mockRun.mockResolvedValue({ kind: "succeeded", skippedExtraction: false });
    const result = await processOneInvoiceExtractJob({} as never, "worker-1");
    expect(result).toEqual({ processed: true, jobId: "job-1", outcome: "succeeded" });
    expect(mockMarkSucceeded).toHaveBeenCalledWith({}, job);
    expect(mockMarkRetryOrDead).not.toHaveBeenCalled();
    expect(mockMarkDeadImmediately).not.toHaveBeenCalled();
  });

  it("routes a retry outcome to markJobRetryOrDead", async () => {
    mockClaim.mockResolvedValue(job);
    const outcome = { kind: "retry", code: "upstream_error", message: "boom" };
    mockRun.mockResolvedValue(outcome);
    const result = await processOneInvoiceExtractJob({} as never, "worker-1");
    if (!result.processed) throw new Error("expected the job to be processed");
    expect(result.outcome).toBe("retry");
    expect(mockMarkRetryOrDead).toHaveBeenCalledWith({}, job, outcome);
    expect(mockMarkSucceeded).not.toHaveBeenCalled();
    expect(mockMarkDeadImmediately).not.toHaveBeenCalled();
  });

  it("routes a dead outcome to markJobDeadImmediately", async () => {
    mockClaim.mockResolvedValue(job);
    const outcome = { kind: "dead", code: "tenant_mismatch_or_missing_subject", message: "nope" };
    mockRun.mockResolvedValue(outcome);
    const result = await processOneInvoiceExtractJob({} as never, "worker-1");
    if (!result.processed) throw new Error("expected the job to be processed");
    expect(result.outcome).toBe("dead");
    expect(mockMarkDeadImmediately).toHaveBeenCalledWith({}, job, outcome);
    expect(mockMarkSucceeded).not.toHaveBeenCalled();
    expect(mockMarkRetryOrDead).not.toHaveBeenCalled();
  });
});
