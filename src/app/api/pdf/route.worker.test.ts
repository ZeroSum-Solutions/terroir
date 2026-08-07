import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const requireMembership = vi.fn();
const enqueue = vi.fn();
const loadArtifact = vi.fn();
const generate = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => requireMembership(...args),
}));

vi.mock("@/domains/wine-lists/wine-list-pdf-service", () => ({
  generateWineListPdf: (...args: unknown[]) => generate(...args),
  WineListPdfGenerationError: class WineListPdfGenerationError extends Error {},
  WineListPdfNotFoundError: class WineListPdfNotFoundError extends Error {},
}));

vi.mock("@/domains/wine-lists/wine-list-pdf-job-service", () => ({
  enqueueWineListPdfJob: (...args: unknown[]) => enqueue(...args),
  loadWineListPdfArtifact: (...args: unknown[]) => loadArtifact(...args),
  WineListPdfArtifactError: class WineListPdfArtifactError extends Error {},
  WineListPdfJobCancelledError: class WineListPdfJobCancelledError extends Error {},
  WineListPdfJobConflictError: class WineListPdfJobConflictError extends Error {},
  WineListPdfJobFailedError: class WineListPdfJobFailedError extends Error {},
  WineListPdfJobNotFoundError: class WineListPdfJobNotFoundError extends Error {},
}));

const { POST } = await import("./route");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function request(body: unknown, key?: string) {
  return new Request("http://localhost/api/pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/pdf worker rollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PDF_WORKER_ENABLED;
    requireMembership.mockResolvedValue({
      supabase: { tenant: "client" },
      restaurantId: RESTAURANT_ID,
    });
    generate.mockResolvedValue({
      filename: "House List.pdf",
      pdf: Buffer.from("%PDF-1.4"),
      template: "classic",
    });
    enqueue.mockResolvedValue({ id: JOB_ID, status: "queued" });
  });

  it("keeps the synchronous binary response when the flag is absent", async () => {
    const response = await POST(request({ listId: LIST_ID, legacyField: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(generate).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("requires a retry-stable key before an enabled enqueue", async () => {
    process.env.PDF_WORKER_ENABLED = "1";
    const response = await POST(request({ listId: LIST_ID }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "A valid Idempotency-Key is required for queued PDF generation.",
      },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns the same durable job reference from the enabled path", async () => {
    process.env.PDF_WORKER_ENABLED = "1";
    const response = await POST(
      request({ listId: LIST_ID, template: "modern" }, "pdf-retry-0001"),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({ jobId: JOB_ID, status: "queued" });
    expect(enqueue).toHaveBeenCalledWith({
      supabase: { tenant: "client" },
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      idempotencyKey: "pdf-retry-0001",
      template: "modern",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("continues serving queued results after rollback disables new enqueues", async () => {
    loadArtifact.mockResolvedValue({
      kind: "ready",
      filename: "House List.pdf",
      pdf: new TextEncoder().encode("%PDF-1.4").buffer,
    });
    const response = await POST(request({ jobId: JOB_ID }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(loadArtifact).toHaveBeenCalledWith({
      supabase: { tenant: "client" },
      restaurantId: RESTAURANT_ID,
      jobId: JOB_ID,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns an honest pending state without exposing job metadata", async () => {
    loadArtifact.mockResolvedValue({ kind: "pending", status: "retrying" });
    const response = await POST(request({ jobId: JOB_ID }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: JOB_ID, status: "retrying" });
  });

  it("never reaches worker or synchronous business logic without auth", async () => {
    requireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const response = await POST(request({ listId: LIST_ID }, "pdf-retry-0001"));
    expect(response.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(loadArtifact).not.toHaveBeenCalled();
  });
});
