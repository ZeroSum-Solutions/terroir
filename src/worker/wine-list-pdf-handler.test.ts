import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseStorageError } from "../adapters/storage/supabase-storage.ts";
import { WineListPdfNotFoundError } from "../domains/wine-lists/wine-list-pdf-service.ts";
import { JobExecutionError } from "./errors.ts";
import { createWineListPdfJobHandler } from "./wine-list-pdf-handler.ts";
import type { BackgroundJob } from "./types.ts";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    job_type: "wine_list_pdf",
    attempt_count: 1,
    max_attempts: 3,
    lease_token: "lease",
    metadata: { template: "modern" },
    restaurant_id: RESTAURANT_ID,
    subject_id: LIST_ID,
    subject_table: "wine_lists",
    status: "running",
    ...overrides,
  };
}

describe("wine-list PDF worker handler", () => {
  const generate = vi.fn();
  const upload = vi.fn();
  const supabase = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    generate.mockResolvedValue({
      filename: "House List.pdf",
      pdf: Buffer.from("%PDF-1.4"),
      template: "modern",
    });
    upload.mockResolvedValue(undefined);
  });

  function handler() {
    return createWineListPdfJobHandler(supabase, {
      generate,
      upload,
    });
  }

  it("converges duplicate delivery on one deterministic private artifact", async () => {
    const first = await handler()(job(), new AbortController().signal);
    const replay = await handler()(job(), new AbortController().signal);

    expect(first).toEqual(replay);
    expect(first).toEqual({
      artifact_path: `${RESTAURANT_ID}/${LIST_ID}_modern.pdf`,
      filename: "House List.pdf",
      list_id: LIST_ID,
      template: "modern",
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        bucket: "generated-exports",
        path: `${RESTAURANT_ID}/${LIST_ID}_modern.pdf`,
        upsert: true,
      }),
    );
  });

  it("rejects untrusted job metadata before rendering", async () => {
    await expect(
      handler()(job({ metadata: { template: "classic", extra: "no" } }), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "invalid_pdf_job_payload",
      retryable: false,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    { job_type: "invoice_ocr" },
    { subject_table: "restaurants" },
    { restaurant_id: "../escape" },
    { subject_id: "not-a-uuid" },
  ])("rejects a misrouted or malformed job payload: %o", async (override) => {
    await expect(
      handler()(job(override), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "invalid_pdf_job_payload",
      retryable: false,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("treats a deleted list as terminal and storage outages as retryable", async () => {
    generate.mockRejectedValueOnce(new WineListPdfNotFoundError());
    await expect(
      handler()(job(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "pdf_source_not_found", retryable: false });

    generate.mockResolvedValueOnce({
      filename: "House List.pdf",
      pdf: Buffer.from("%PDF-1.4"),
      template: "modern",
    });
    upload.mockRejectedValueOnce(new SupabaseStorageError("unavailable"));
    await expect(
      handler()(job(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "pdf_artifact_upload_failed",
      retryable: true,
    });
  });

  it("honors cancellation before any business side effect", async () => {
    const controller = new AbortController();
    controller.abort(new JobExecutionError("worker_shutdown", true, "stop"));
    await expect(handler()(job(), controller.signal)).rejects.toMatchObject({
      code: "worker_shutdown",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("preserves the worker abort reason during an in-flight render", async () => {
    const controller = new AbortController();
    const abortReason = new JobExecutionError(
      "worker_shutdown",
      true,
      "Worker is shutting down",
    );
    generate.mockImplementationOnce(async () => {
      controller.abort(abortReason);
      throw new DOMException("aborted", "AbortError");
    });

    await expect(handler()(job(), controller.signal)).rejects.toBe(abortReason);
    expect(upload).not.toHaveBeenCalled();
  });

  it("normalizes an unclassified abort as a retryable interruption", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(handler()(job(), controller.signal)).rejects.toMatchObject({
      code: "job_aborted",
      retryable: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
