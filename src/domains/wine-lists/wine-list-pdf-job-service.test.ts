import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueWineListPdfJob,
  loadWineListPdfArtifact,
  WineListPdfArtifactError,
  WineListPdfJobConflictError,
  WineListPdfJobNotFoundError,
} from "./wine-list-pdf-job-service";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "22222222-2222-4222-8222-222222222222";
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

describe("wine-list PDF job service", () => {
  const rpc = vi.fn();
  const download = vi.fn();
  const fromStorage = vi.fn(() => ({ download }));

  beforeEach(() => vi.clearAllMocks());

  it("enqueues one tenant-scoped durable job with the caller retry key", async () => {
    const listQuery = query({ data: { id: LIST_ID }, error: null });
    rpc.mockResolvedValue({
      data: { id: JOB_ID, status: "queued" },
      error: null,
    });
    const supabase = {
      from: vi.fn(() => listQuery),
      rpc,
    } as never;

    await expect(enqueueWineListPdfJob({
      supabase,
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      idempotencyKey: "pdf-retry-0001",
      template: "modern",
    })).resolves.toEqual({ id: JOB_ID, status: "queued" });
    expect(rpc).toHaveBeenCalledWith("enqueue_background_job", {
      p_restaurant_id: RESTAURANT_ID,
      p_job_type: "wine_list_pdf",
      p_idempotency_key: "pdf-retry-0001",
      p_subject_table: "wine_lists",
      p_subject_id: LIST_ID,
      p_metadata: { template: "modern" },
      p_max_attempts: 3,
    });
  });

  it("does not enqueue a cross-tenant or missing list", async () => {
    const supabase = {
      from: vi.fn(() => query({ data: null, error: null })),
      rpc,
    } as never;
    await expect(enqueueWineListPdfJob({
      supabase,
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      idempotencyKey: "pdf-retry-0001",
    })).rejects.toBeInstanceOf(WineListPdfJobNotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces durable idempotency conflicts without creating another job", async () => {
    const listQuery = query({ data: { id: LIST_ID }, error: null });
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "22023",
        message: "idempotency key was reused with different job input",
      },
    });
    const supabase = { from: vi.fn(() => listQuery), rpc } as never;
    await expect(enqueueWineListPdfJob({
      supabase,
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      idempotencyKey: "pdf-retry-0001",
    })).rejects.toBeInstanceOf(WineListPdfJobConflictError);
  });

  it("does not mislabel other RPC validation errors as idempotency conflicts", async () => {
    const listQuery = query({ data: { id: LIST_ID }, error: null });
    const validationError = {
      code: "22023",
      message: "unsupported background job type",
    };
    rpc.mockResolvedValue({ data: null, error: validationError });
    const supabase = { from: vi.fn(() => listQuery), rpc } as never;

    await expect(enqueueWineListPdfJob({
      supabase,
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      idempotencyKey: "pdf-retry-0001",
    })).rejects.toBe(validationError);
  });

  it("returns an existing terminal job when an idempotent enqueue is replayed", async () => {
    const listQuery = query({ data: { id: LIST_ID }, error: null });
    rpc.mockResolvedValue({
      data: { id: JOB_ID, status: "failed" },
      error: null,
    });
    const supabase = { from: vi.fn(() => listQuery), rpc } as never;

    await expect(enqueueWineListPdfJob({
      supabase,
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      idempotencyKey: "pdf-retry-0001",
    })).resolves.toEqual({ id: JOB_ID, status: "failed" });
  });

  it("downloads only a succeeded artifact at the exact tenant/list path", async () => {
    const jobQuery = query({
      data: {
        id: JOB_ID,
        job_type: "wine_list_pdf",
        restaurant_id: RESTAURANT_ID,
        subject_id: LIST_ID,
        subject_table: "wine_lists",
        status: "succeeded",
        result: {
          artifact_path: `${RESTAURANT_ID}/${LIST_ID}_classic.pdf`,
          filename: "House List.pdf",
          list_id: LIST_ID,
          template: "classic",
        },
      },
      error: null,
    });
    download.mockResolvedValue({
      data: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
      error: null,
    });
    const supabase = {
      from: vi.fn(() => jobQuery),
      storage: { from: fromStorage },
    } as never;

    const result = await loadWineListPdfArtifact({
      supabase,
      restaurantId: RESTAURANT_ID,
      jobId: JOB_ID,
    });
    expect(result.kind).toBe("ready");
    expect(fromStorage).toHaveBeenCalledWith("generated-exports");
    expect(download).toHaveBeenCalledWith(
      `${RESTAURANT_ID}/${LIST_ID}_classic.pdf`,
    );
  });

  it("rejects forged result paths before Storage access", async () => {
    const jobQuery = query({
      data: {
        id: JOB_ID,
        job_type: "wine_list_pdf",
        restaurant_id: RESTAURANT_ID,
        subject_id: LIST_ID,
        subject_table: "wine_lists",
        status: "succeeded",
        result: {
          artifact_path: `other/${LIST_ID}_classic.pdf`,
          filename: "House List.pdf",
          list_id: LIST_ID,
          template: "classic",
        },
      },
      error: null,
    });
    const supabase = {
      from: vi.fn(() => jobQuery),
      storage: { from: fromStorage },
    } as never;
    await expect(loadWineListPdfArtifact({
      supabase,
      restaurantId: RESTAURANT_ID,
      jobId: JOB_ID,
    })).rejects.toBeInstanceOf(WineListPdfArtifactError);
    expect(fromStorage).not.toHaveBeenCalled();
  });
});
