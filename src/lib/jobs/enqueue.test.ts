import { describe, expect, it, vi } from "vitest";
import { enqueueInvoiceExtractJob } from "@/lib/jobs/enqueue";

describe("enqueueInvoiceExtractJob", () => {
  it("inserts a queued job and returns created:true on the first call", async () => {
    const insertedRow = { id: "job-1" };
    const supabase = {
      from: vi.fn(() => ({
        insert: vi.fn((row: Record<string, unknown>) => {
          expect(row).toMatchObject({
            restaurant_id: "restaurant-a",
            job_type: "invoice_extract",
            status: "queued",
            subject_table: "invoice_scans",
            subject_id: "scan-1",
            idempotency_key: "scan-1",
          });
          return {
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: insertedRow, error: null })),
            })),
          };
        }),
      })),
    };

    const result = await enqueueInvoiceExtractJob({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      scanId: "scan-1",
    });

    expect(result).toEqual({ jobId: "job-1", created: true });
  });

  it("returns the existing job (created:false) when the idempotency key already exists", async () => {
    const uniqueViolation = { code: "23505", message: "duplicate key" };
    const existingRow = { id: "job-existing" };
    const supabase = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => ({ data: null, error: uniqueViolation })),
          })),
        })),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: existingRow, error: null })),
            })),
          })),
        })),
      })),
    };

    const result = await enqueueInvoiceExtractJob({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      scanId: "scan-1",
    });

    expect(result).toEqual({ jobId: "job-existing", created: false });
  });

  it("rethrows a non-conflict insert error", async () => {
    const dbError = { code: "XX000", message: "boom" };
    const supabase = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => ({ data: null, error: dbError })),
          })),
        })),
      })),
    };

    await expect(
      enqueueInvoiceExtractJob({
        supabase: supabase as never,
        restaurantId: "restaurant-a",
        scanId: "scan-1",
      }),
    ).rejects.toBe(dbError);
  });

  /** Builds a supabase stub for the unique-violation + fetch-existing path. */
  function supabaseForConflict(opts: {
    existingStatus: string;
    revive?: { data: Array<{ id: string }> | null; error: unknown };
  }) {
    const uniqueViolation = { code: "23505", message: "duplicate key" };
    const existingRow = { id: "job-existing", status: opts.existingStatus };
    const updateSpy = vi.fn((patch: Record<string, unknown>) => {
      capturedPatch = patch;
      return {
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            select: vi.fn(async () => opts.revive ?? { data: [existingRow], error: null }),
          })),
        })),
      };
    });
    let capturedPatch: Record<string, unknown> | undefined;
    const supabase = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => ({ data: null, error: uniqueViolation })),
          })),
        })),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: existingRow, error: null })),
            })),
          })),
        })),
        update: updateSpy,
      })),
    };
    return { supabase, updateSpy, getPatch: () => capturedPatch };
  }

  it("revives a dead job back to queued (fields reset) instead of returning it dead", async () => {
    const { supabase, updateSpy, getPatch } = supabaseForConflict({ existingStatus: "dead" });

    const result = await enqueueInvoiceExtractJob({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      scanId: "scan-1",
    });

    expect(result).toEqual({ jobId: "job-existing", created: false });
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(getPatch()).toMatchObject({
      status: "queued",
      attempt_count: 0,
      error_code: null,
      error_message: null,
      claimed_by: null,
      claimed_at: null,
    });
    expect(typeof getPatch()!.run_after).toBe("string");
  });

  it.each(["queued", "processing", "succeeded"])(
    "does not attempt to revive a %s job — just returns it",
    async (status) => {
      const { supabase, updateSpy } = supabaseForConflict({ existingStatus: status });

      const result = await enqueueInvoiceExtractJob({
        supabase: supabase as never,
        restaurantId: "restaurant-a",
        scanId: "scan-1",
      });

      expect(result).toEqual({ jobId: "job-existing", created: false });
      expect(updateSpy).not.toHaveBeenCalled();
    },
  );

  it("returns the existing id, created:false when a dead-row revival races and matches 0 rows", async () => {
    const { supabase, updateSpy } = supabaseForConflict({
      existingStatus: "dead",
      revive: { data: [], error: null },
    });

    const result = await enqueueInvoiceExtractJob({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      scanId: "scan-1",
    });

    expect(result).toEqual({ jobId: "job-existing", created: false });
    expect(updateSpy).toHaveBeenCalledOnce();
  });
});
