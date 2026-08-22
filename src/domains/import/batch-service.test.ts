import { describe, expect, it, vi } from "vitest";
import {
  applyImportBatchChunk,
  confirmImportBatch,
  deriveBatchStatus,
  resolveImportBatchRow,
  revertImportBatch,
  type BatchCounts,
} from "./batch-service";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";

function csv(rows: string) {
  return Buffer.from(`producer,name,vintage,quantity,unit_cost\n${rows}`);
}

describe("deriveBatchStatus", () => {
  const base: BatchCounts = { total: 10, applied: 0, excluded: 0, pending: 0, eligibleNotApplied: 10 };

  it("is 'created' when nothing has been applied yet", () => {
    expect(deriveBatchStatus(base)).toBe("created");
  });

  it("is 'applying' once some rows are applied but work remains", () => {
    expect(deriveBatchStatus({ ...base, applied: 3, eligibleNotApplied: 7 })).toBe("applying");
  });

  it("is 'applying' while any row is still pending resolution, even if all eligible rows are applied", () => {
    expect(deriveBatchStatus({ total: 10, applied: 8, excluded: 0, pending: 2, eligibleNotApplied: 0 })).toBe(
      "applying",
    );
  });

  it("is 'completed' once every row has a final fate and nothing is pending", () => {
    expect(deriveBatchStatus({ total: 10, applied: 7, excluded: 3, pending: 0, eligibleNotApplied: 0 })).toBe(
      "completed",
    );
  });
});

describe("confirmImportBatch", () => {
  it("persists the batch and one row per CSV data row (re-deriving from the file, not trusting a client payload)", async () => {
    const insertedRows: unknown[] = [];
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [{ idx: 0, lwin_id: null, score: null }], error: null }),
      from: vi.fn((table: string) => {
        if (table === "import_batches") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { id: BATCH_ID }, error: null }),
              }),
            }),
          };
        }
        if (table === "import_batch_rows") {
          return {
            insert: async (rows: unknown[]) => {
              insertedRows.push(...rows);
              return { error: null };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const result = await confirmImportBatch(
      supabase as never,
      RESTAURANT_ID,
      USER_ID,
      "cellar.csv",
      csv("Domaine A,Cuvee 1,2020,6,24.50\n"),
    );

    expect(result).toMatchObject({ ok: true, batchId: BATCH_ID, totalRows: 1 });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      batch_id: BATCH_ID,
      restaurant_id: RESTAURANT_ID,
      row_number: 1,
      row_state: "valid",
    });
  });

  it("deletes the orphaned batch when the row insert fails (no half-written batch)", async () => {
    let batchDeleted = false;
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
      from: vi.fn((table: string) => {
        if (table === "import_batches") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { id: BATCH_ID }, error: null }),
              }),
            }),
            delete: () => ({
              eq: async (_col: string, id: string) => {
                if (id === BATCH_ID) batchDeleted = true;
                return { error: null };
              },
            }),
          };
        }
        if (table === "import_batch_rows") {
          return { insert: async () => ({ error: { message: "boom" } }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    await expect(
      confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", csv("Domaine A,Cuvee 1,2020,6,24.50\n")),
    ).rejects.toThrow();
    expect(batchDeleted).toBe(true);
  });

  it("rejects an empty CSV without creating a batch", async () => {
    const from = vi.fn();
    const supabase = { rpc: vi.fn(), from };
    const result = await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "empty.csv", csv(""));
    expect(result).toMatchObject({ ok: false, error: { code: "empty_file" } });
    expect(from).not.toHaveBeenCalled();
  });
});

describe("applyImportBatchChunk", () => {
  it("calls the chunk RPC and recomputes batch status from row counts", async () => {
    const statusUpdates: string[] = [];
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          { row_id: "r1", row_number: 1, outcome: "applied", inventory_item_id: "inv1", error_message: null },
        ],
        error: null,
      }),
      from: vi.fn((table: string) => {
        if (table === "import_batch_rows") {
          return {
            select: () => ({
              eq: async () => ({ data: [{ apply_status: "applied", resolution: "auto" }], error: null }),
            }),
          };
        }
        if (table === "import_batches") {
          return {
            update: (patch: { status: string }) => {
              statusUpdates.push(patch.status);
              return { eq: () => ({ neq: async () => ({ error: null }) }) };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const result = await applyImportBatchChunk(supabase as never, BATCH_ID);
    expect(supabase.rpc).toHaveBeenCalledWith("apply_import_batch_chunk", expect.objectContaining({ p_batch_id: BATCH_ID }));
    expect(result.processed).toEqual([
      { rowId: "r1", rowNumber: 1, outcome: "applied", inventoryItemId: "inv1", errorMessage: null },
    ]);
    expect(result.status).toBe("completed");
    expect(statusUpdates).toEqual(["completed"]);
  });
});

describe("resolveImportBatchRow", () => {
  function supabaseWithRow(row: { resolution: string; cost_status: string }) {
    const updates: unknown[] = [];
    return {
      updates,
      from: vi.fn((table: string) => {
        if (table === "import_batch_rows") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: "row-1", batch_id: BATCH_ID, ...row },
                    error: null,
                  }),
                }),
              }),
            }),
            update: (patch: unknown) => {
              updates.push(patch);
              return { eq: () => ({ eq: async () => ({ error: null }) }) };
            },
          };
        }
        if (table === "import_batches") {
          return { update: () => ({ eq: () => ({ neq: async () => ({ error: null }) }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
  }

  it("requires a non-negative manual unit cost to include a missing-cost row", async () => {
    const supabase = supabaseWithRow({ resolution: "pending", cost_status: "missing" });
    const result = await resolveImportBatchRow(supabase as never, RESTAURANT_ID, USER_ID, "row-1", "include");
    expect(result).toMatchObject({ ok: false, error: { code: "manual_cost_required" } });
    expect(supabase.updates).toHaveLength(0);
  });

  it("includes a missing-cost row once a manual cost is supplied", async () => {
    const supabase = supabaseWithRow({ resolution: "pending", cost_status: "missing" });
    const result = await resolveImportBatchRow(supabase as never, RESTAURANT_ID, USER_ID, "row-1", "include", 19.99);
    expect(result).toEqual({ ok: true });
    expect(supabase.updates[0]).toMatchObject({ resolution: "include", manual_unit_cost: 19.99 });
  });

  it("excludes a row without requiring a manual cost", async () => {
    const supabase = supabaseWithRow({ resolution: "pending", cost_status: "missing" });
    const result = await resolveImportBatchRow(supabase as never, RESTAURANT_ID, USER_ID, "row-1", "exclude");
    expect(result).toEqual({ ok: true });
    expect(supabase.updates[0]).toMatchObject({ resolution: "exclude" });
  });

  it("refuses to resolve a row that isn't pending", async () => {
    const supabase = supabaseWithRow({ resolution: "auto", cost_status: "present" });
    const result = await resolveImportBatchRow(supabase as never, RESTAURANT_ID, USER_ID, "row-1", "exclude");
    expect(result).toMatchObject({ ok: false, error: { code: "not_pending" } });
  });
});

describe("revertImportBatch", () => {
  it("returns the reverted row count on success", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 4, error: null }) };
    const result = await revertImportBatch(supabase as never, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 4 });
  });

  it("translates a not-found error", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0002", message: "not found" } }) };
    const result = await revertImportBatch(supabase as never, BATCH_ID);
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("translates a not-completed error", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0001", message: "not completed" } }) };
    const result = await revertImportBatch(supabase as never, BATCH_ID);
    expect(result).toMatchObject({ ok: false, error: { code: "not_completed" } });
  });
});
