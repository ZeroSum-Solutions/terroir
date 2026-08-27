import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  applyImportBatchChunk,
  canonicalizeRowOverrides,
  confirmImportBatch,
  deriveBatchStatus,
  resolveImportBatchRow,
  revertImportBatch,
  type BatchCounts,
} from "./batch-service";
import { CLEANUP_BUDGET_FROM_ENTRY_MS } from "./constants";

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

/** Dispatches supabase.rpc(name, args) calls to per-name handlers — every
 * P3-era test needs this because confirmImportBatch/applyImportBatchChunk
 * now call TWO different RPCs in one invocation (match_lwin_bulk +
 * create_import_batch, or apply_import_batch_chunk + count_import_batch_
 * rows), so a single canned mockResolvedValue would answer the wrong call
 * with the wrong shape. */
function makeRpc(handlers: Record<string, (args: unknown) => { data: unknown; error: unknown }>) {
  return vi.fn((name: string, args: unknown) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected rpc ${name}`);
    return Promise.resolve(handler(args));
  });
}

describe("confirmImportBatch", () => {
  it("persists the batch via ONE create_import_batch RPC call (C09: batch+rows insert is now one atomic function call, not two client statements)", async () => {
    let createArgs: { p_rows: unknown[]; p_content_sha256: string } | undefined;
    const supabase = {
      rpc: makeRpc({
        match_lwin_bulk: () => ({ data: [{ idx: 0, lwin_id: null, score: null }], error: null }),
        create_import_batch: (args) => {
          createArgs = args as typeof createArgs;
          return { data: { batchId: BATCH_ID }, error: null };
        },
      }),
    };

    const result = await confirmImportBatch(
      supabase as never,
      RESTAURANT_ID,
      USER_ID,
      "cellar.csv",
      csv("Domaine A,Cuvee 1,2020,6,24.50\n"),
    );

    expect(result).toMatchObject({ ok: true, alreadyExists: false, batchId: BATCH_ID, totalRows: 1 });
    expect(createArgs?.p_rows).toHaveLength(1);
    expect(createArgs?.p_rows[0]).toMatchObject({ row_number: 1, row_state: "valid" });
    // §2.2: hashed over the raw bytes, server-side — a real sha256 hex
    // digest, not empty/undefined.
    expect(createArgs?.p_content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // Sol audit (2026-08-27) finding 5: producer-less rows must reach the
  // create_import_batch RPC payload with producer as EMPTY STRING, never
  // JSON null — apply (0108) inserts raw->>'producer' straight into
  // wines.producer, which is NOT NULL (0002), so a null here would fail
  // every such row at apply time.
  it("sends producer as empty string (never null) in the RPC payload for a producer-less file", async () => {
    let createArgs: { p_rows: Array<{ raw: Record<string, unknown>; row_state: string }> } | undefined;
    const supabase = {
      rpc: makeRpc({
        match_lwin_bulk: () => ({ data: [], error: null }),
        create_import_batch: (args) => {
          createArgs = args as typeof createArgs;
          return { data: { batchId: BATCH_ID }, error: null };
        },
      }),
    };

    const result = await confirmImportBatch(
      supabase as never,
      RESTAURANT_ID,
      USER_ID,
      "cellar.csv",
      Buffer.from("wine name,quantity,cost price\nA.F. Gros Richebourg Grand Cru,3,$678.00\n"),
    );

    expect(result).toMatchObject({ ok: true, totalRows: 1 });
    expect(createArgs?.p_rows[0]?.row_state).toBe("valid");
    expect(createArgs?.p_rows[0]?.raw.producer).toBe("");
    expect(createArgs?.p_rows[0]?.raw.name).toBe("A.F. Gros Richebourg Grand Cru");
    expect(createArgs?.p_rows[0]?.raw.unit_cost).toBe("678.00");
  });

  it("propagates a create_import_batch failure as-is (C09: the function's own implicit transaction is the only rollback needed — no separate client-side cleanup step exists anymore)", async () => {
    const supabase = {
      rpc: makeRpc({
        match_lwin_bulk: () => ({ data: [], error: null }),
        create_import_batch: () => ({ data: null, error: { code: "23514", message: "check violation" } }),
      }),
    };

    await expect(
      confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", csv("Domaine A,Cuvee 1,2020,6,24.50\n")),
    ).rejects.toThrow();
  });

  it("looks up and returns the pre-existing batch as a resume pointer on a 23505 content_sha256 conflict (P3 §2.2)", async () => {
    const supabase = {
      rpc: makeRpc({
        match_lwin_bulk: () => ({ data: [], error: null }),
        create_import_batch: () => ({
          data: null,
          error: { code: "23505", message: 'duplicate key value violates unique constraint "import_batches_content_sha256_idx"' },
        }),
        count_import_batch_rows: () => ({
          data: [{ total: 5, applied: 5, excluded: 0, pending: 0, eligible_not_applied: 0 }],
          error: null,
        }),
      }),
      from: vi.fn((table: string) => {
        if (table === "import_batches") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  neq: () => ({
                    maybeSingle: async () => ({
                      data: { id: BATCH_ID, status: "completed", session_id: "session-x" },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
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

    // sessionId is the EXISTING batch's own session — a chunked-upload
    // caller compares this against the session it's uploading into, so a
    // duplicate that belongs to a DIFFERENT session is never silently
    // adopted (see session-step.tsx's confirmChunkedSession).
    expect(result).toMatchObject({ ok: true, alreadyExists: true, batchId: BATCH_ID, status: "completed", sessionId: "session-x" });
  });

  it("rejects an empty CSV without ever calling create_import_batch", async () => {
    const rpc = vi.fn();
    const supabase = { rpc, from: vi.fn() };
    const result = await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "empty.csv", csv(""));
    expect(result).toMatchObject({ ok: false, error: { code: "empty_file" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  // Inline row-fix overrides — let an operator fix a rejected row inline
  // instead of "fix the errors above and re-upload".
  describe("rowOverrides", () => {
    it("applies an override before validation, flipping an error row to valid", async () => {
      let createArgs: { p_rows: Array<{ row_number: number; row_state: string; raw: Record<string, unknown> }> } | undefined;
      const supabase = {
        rpc: makeRpc({
          match_lwin_bulk: () => ({ data: [{ idx: 0, lwin_id: null, score: null }], error: null }),
          create_import_batch: (args) => {
            createArgs = args as typeof createArgs;
            return { data: { batchId: BATCH_ID }, error: null };
          },
        }),
      };

      // Fractional quantity 0.9 is STRICTLY rejected by the validator —
      // the inline fix here overrides it to a whole number, never adds
      // partial-bottle logic.
      const result = await confirmImportBatch(
        supabase as never,
        RESTAURANT_ID,
        USER_ID,
        "cellar.csv",
        csv("Domaine A,Cuvee 1,2020,0.9,24.50\n"),
        { rowOverrides: { "1": { quantity: "6" } } },
      );

      expect(result).toMatchObject({ ok: true, alreadyExists: false, totalRows: 1 });
      expect(createArgs?.p_rows[0]).toMatchObject({ row_number: 1, row_state: "valid" });
      expect(createArgs?.p_rows[0]?.raw.quantity).toBe("6");
    });

    it("leaves a still-invalid override as an error row with the normal per-row reason, never a whole-batch rejection", async () => {
      let createArgs: {
        p_rows: Array<{ row_number: number; row_state: string; validation_errors: Array<{ field: string }> }>;
      } | undefined;
      const supabase = {
        rpc: makeRpc({
          match_lwin_bulk: () => ({ data: [], error: null }),
          create_import_batch: (args) => {
            createArgs = args as typeof createArgs;
            return { data: { batchId: BATCH_ID }, error: null };
          },
        }),
      };

      // The override itself is still fractional — server-side validation
      // stays the authority and rejects it exactly as it would any other
      // fractional quantity, never silently accepting a client's claim.
      const result = await confirmImportBatch(
        supabase as never,
        RESTAURANT_ID,
        USER_ID,
        "cellar.csv",
        csv("Domaine A,Cuvee 1,2020,0.9,24.50\n"),
        { rowOverrides: { "1": { quantity: "0.9" } } },
      );

      expect(result).toMatchObject({ ok: true, alreadyExists: false, totalRows: 1 });
      expect(createArgs?.p_rows[0]?.row_state).toBe("error");
      expect(createArgs?.p_rows[0]?.validation_errors.some((e) => e.field === "quantity")).toBe(true);
    });

    it("rejects an out-of-bounds row override index without calling create_import_batch", async () => {
      const rpc = makeRpc({
        match_lwin_bulk: () => ({ data: [{ idx: 0, lwin_id: null, score: null }], error: null }),
        create_import_batch: () => ({ data: { batchId: BATCH_ID }, error: null }),
      });
      const supabase = { rpc };

      const result = await confirmImportBatch(
        supabase as never,
        RESTAURANT_ID,
        USER_ID,
        "cellar.csv",
        csv("Domaine A,Cuvee 1,2020,6,24.50\n"),
        { rowOverrides: { "2": { quantity: "6" } } },
      );

      expect(result).toMatchObject({ ok: false, error: { code: "invalid_row_override" } });
      expect(rpc).not.toHaveBeenCalledWith("create_import_batch", expect.anything());
    });

    it("folds overrides into content_sha256 so the same file + different overrides hash differently", async () => {
      const captured: string[] = [];
      const supabase = {
        rpc: makeRpc({
          match_lwin_bulk: () => ({ data: [{ idx: 0, lwin_id: null, score: null }], error: null }),
          create_import_batch: (args) => {
            captured.push((args as { p_content_sha256: string }).p_content_sha256);
            return { data: { batchId: BATCH_ID }, error: null };
          },
        }),
      };
      const file = csv("Domaine A,Cuvee 1,2020,6,24.50\n");
      const bareHash = createHash("sha256").update(file).digest("hex");

      await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", file);
      await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", file, {
        rowOverrides: { "1": { quantity: "12" } },
      });
      await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", file, {
        rowOverrides: { "1": { quantity: "18" } },
      });

      // No overrides -> unchanged bare-file digest, so every batch
      // confirmed before this feature existed still resolves.
      expect(captured[0]).toBe(bareHash);
      // Overrides present -> different from the bare hash and from each
      // OTHER override set (same file, different overrides = distinct
      // batch).
      expect(captured[1]).not.toBe(bareHash);
      expect(captured[2]).not.toBe(bareHash);
      expect(captured[1]).not.toBe(captured[2]);
      expect(new Set(captured).size).toBe(3);
    });

    it("hashes identically for the same overrides regardless of client-side key order (resume still works)", async () => {
      const captured: string[] = [];
      const supabase = {
        rpc: makeRpc({
          match_lwin_bulk: () => ({ data: [{ idx: 0, lwin_id: null, score: null }, { idx: 1, lwin_id: null, score: null }], error: null }),
          create_import_batch: (args) => {
            captured.push((args as { p_content_sha256: string }).p_content_sha256);
            return { data: { batchId: BATCH_ID }, error: null };
          },
        }),
      };
      const file = csv("Domaine A,Cuvee 1,2020,6,24.50\nDomaine B,Cuvee 2,2019,3,18.00\n");

      await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", file, {
        rowOverrides: { "1": { quantity: "6", unit_cost: "25.00" }, "2": { name: "Cuvee 2 Fixed" } },
      });
      await confirmImportBatch(supabase as never, RESTAURANT_ID, USER_ID, "cellar.csv", file, {
        // Same override content, different key/field order both at the
        // row level and the field level.
        rowOverrides: { "2": { name: "Cuvee 2 Fixed" }, "1": { unit_cost: "25.00", quantity: "6" } },
      });

      expect(captured[0]).toBe(captured[1]);
    });
  });
});

describe("canonicalizeRowOverrides", () => {
  it("returns null for undefined overrides", () => {
    expect(canonicalizeRowOverrides(undefined)).toBeNull();
  });

  it("returns null when every row's override is an empty field set", () => {
    expect(canonicalizeRowOverrides({ "1": {}, "2": {} })).toBeNull();
  });

  it("sorts rows numerically and fields in CANONICAL_HEADERS order, regardless of input order", () => {
    const a = canonicalizeRowOverrides({ "10": { quantity: "1" }, "2": { unit_cost: "5.00", name: "X" } });
    const b = canonicalizeRowOverrides({ "2": { name: "X", unit_cost: "5.00" }, "10": { quantity: "1" } });
    expect(a).toBe(b);
    expect(a).toBe(JSON.stringify([
      [2, [["name", "X"], ["unit_cost", "5.00"]]],
      [10, [["quantity", "1"]]],
    ]));
  });
});

describe("applyImportBatchChunk", () => {
  it("calls the chunk RPC and recomputes batch status via count_import_batch_rows (C03: replaces the old uncapped .select())", async () => {
    const statusUpdates: string[] = [];
    const supabase = {
      rpc: makeRpc({
        apply_import_batch_chunk: () => ({
          data: [{ row_id: "r1", row_number: 1, outcome: "applied", inventory_item_id: "inv1", error_message: null }],
          error: null,
        }),
        count_import_batch_rows: () => ({
          data: [{ total: 1, applied: 1, excluded: 0, pending: 0, eligible_not_applied: 0 }],
          error: null,
        }),
      }),
      from: vi.fn((table: string) => {
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
    expect(supabase.rpc).toHaveBeenCalledWith("count_import_batch_rows", { p_batch_id: BATCH_ID });
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

/** A thenable mini query-builder: every chain method returns itself (so
 * any call order/combination works), and `await`ing the chain (or calling
 * a terminal method like .maybeSingle()) resolves to `result`. Good
 * enough for mocks that don't need to inspect which filters were applied. */
function chain(result: { data: unknown; error: unknown }) {
  const node: Record<string, unknown> = {
    select: () => node,
    eq: () => node,
    neq: () => node,
    in: () => node,
    not: () => node,
    gte: () => node,
    order: () => node,
    range: () => node,
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return node;
}

/** Sol audit 2026-08-27 round 3, finding 8(a): a query-builder mock that
 * RECORDS every `.range()`/`.order()` call it receives (into `calls`,
 * pushed by the caller) rather than just serving canned pages by
 * invocation count — so a pagination test can assert the actual
 * from/to/column values a paging loop used, not just that it happened to
 * call `from()` the right number of times. */
type TrackedCall = { table: string; range?: [number, number]; order?: [string, unknown] };
function trackedChain(calls: TrackedCall[], table: string, result: { data: unknown; error: unknown }) {
  const record: TrackedCall = { table };
  calls.push(record);
  const node: Record<string, unknown> = {
    select: () => node,
    eq: () => node,
    neq: () => node,
    in: () => node,
    not: () => node,
    gte: () => node,
    order: (column: string, opts?: unknown) => {
      record.order = [column, opts];
      return node;
    },
    range: (from: number, to: number) => {
      record.range = [from, to];
      return node;
    },
    then: (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return node;
}

/** A `from` mock for revertImportBatch's cleanup step that finds nothing
 * to clean up — for tests that only care about the RPC-translation
 * behavior, not the cleanup itself. The snapshot read (import_batch_rows,
 * apply_status = 'applied') now happens BEFORE the RPC call regardless of
 * whether the RPC ends up succeeding, so this needs to answer that call
 * even for the RPC-error tests below. */
function noopCleanupFrom() {
  return vi.fn((table: string) => {
    if (table === "import_batch_rows") {
      return chain({ data: [], error: null });
    }
    if (table === "wines") {
      return { select: () => chain({ data: [], error: null }) };
    }
    return chain({ data: [], error: null });
  });
}

describe("revertImportBatch", () => {
  it("returns the reverted row count on success", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 4, error: null }), from: noopCleanupFrom() };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 4, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
  });

  it("translates a not-found error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0002", message: "not found" } }),
      from: noopCleanupFrom(),
    };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("translates a not-completed error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0001", message: "not completed" } }),
      from: noopCleanupFrom(),
    };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toMatchObject({ ok: false, error: { code: "not_completed" } });
  });

  it("still calls the revert RPC and returns ok with zero cleanup counts when the applied-rows snapshot read itself throws (Sol audit 2026-08-27 round 3, finding 4 — the inventory revert must never be blocked by a cleanup-support read)", async () => {
    let rpcCalled = false;
    const supabase = {
      rpc: vi.fn((name: string) => {
        if (name === "revert_import_batch") rpcCalled = true;
        return Promise.resolve({ data: 9, error: null });
      }),
      from: vi.fn((table: string) => {
        if (table === "import_batch_rows") {
          // The snapshot read itself throws — e.g. a network error, not a
          // { data, error } response the query builder resolves normally.
          throw new Error("boom: snapshot read failed");
        }
        return chain({ data: [], error: null });
      }),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(rpcCalled).toBe(true);
    expect(result).toEqual({ ok: true, revertedCount: 9, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("reads the applied-rows snapshot BEFORE calling revert_import_batch — the RPC itself sets updated_at = now() on every row it reverts, so reading after would destroy the exact evidence the whole redesign depends on (Sol audit 2026-08-27 round 2, ordering requirement)", async () => {
    const callOrder: string[] = [];
    const supabase = {
      rpc: vi.fn((name: string) => {
        callOrder.push(`rpc:${name}`);
        return Promise.resolve({ data: 1, error: null });
      }),
      from: vi.fn((table: string) => {
        if (table === "import_batch_rows" && !callOrder.includes("from:import_batch_rows")) {
          callOrder.push("from:import_batch_rows");
        }
        if (table === "wines") return { select: () => chain({ data: [], error: null }) };
        return chain({ data: [], error: null });
      }),
    };
    await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    const snapshotRead = callOrder.indexOf("from:import_batch_rows");
    const rpcCall = callOrder.indexOf("rpc:revert_import_batch");
    expect(snapshotRead).toBeGreaterThanOrEqual(0);
    expect(rpcCall).toBeGreaterThanOrEqual(0);
    expect(snapshotRead).toBeLessThan(rpcCall);
  });

  it("pages the applied-rows snapshot with .range AND a deterministic .order (Sol audit 2026-08-27 round 2, finding 4/6 — .range alone does not guarantee page 2 picks up where page 1 left off)", async () => {
    const calls: TrackedCall[] = [];
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `row-${i}`,
      applied_wine_id: null,
      updated_at: "2026-01-01T00:00:00.000000Z",
      lwin_id: null,
      lwin_score: null,
    }));
    const page2 = Array.from({ length: 300 }, (_, i) => ({
      id: `row-${1000 + i}`,
      applied_wine_id: null,
      updated_at: "2026-01-01T00:00:00.000000Z",
      lwin_id: null,
      lwin_score: null,
    }));
    let snapshotCall = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        snapshotCall += 1;
        if (snapshotCall === 1) return trackedChain(calls, table, { data: page1, error: null });
        if (snapshotCall === 2) return trackedChain(calls, table, { data: page2, error: null });
        return trackedChain(calls, table, { data: [], error: null });
      }
      if (table === "wines") return { select: () => trackedChain(calls, table, { data: [], error: null }) };
      return trackedChain(calls, table, { data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1300, error: null }), from };

    await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);

    const snapshotReads = calls.filter((c) => c.table === "import_batch_rows" && c.range);
    expect(snapshotReads.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(snapshotReads.every((c) => c.order?.[0] === "id")).toBe(true);
  });
});

describe("revertImportBatch orphan wine cleanup", () => {
  const WINE_ID = "55555555-5555-4555-8555-555555555555";
  const APPLY_TS = "2026-01-01T00:00:01.000000Z";

  /** Builds the full `from` dispatcher for a revert cleanup call. All
   * timestamp-equality evidence (`snapshotRows`, `wineRows.created_at`)
   * is supplied explicitly by each test — nothing here infers it — so a
   * test that means guard 1 (the timestamp-equality check, proof against
   * non-malicious writers only — see cleanupOrphanWines' own header) to
   * MATCH must say so with matching timestamps, and a test that means it
   * NOT to match must say so with mismatched ones. `referencedByTable`
   * lists, per wine-referencing table, which wine ids that table has a
   * row for. `crossBatchWineIds` lists wine ids some OTHER batch's
   * import_batch_rows.applied_wine_id still names. */
  function makeCleanupSupabase(opts: {
    snapshotRows: Array<{ applied_wine_id: string; updated_at: string }>;
    wineRows: Array<{ id: string; restaurant_id: string; created_at: string }>;
    referencedByTable?: Record<string, string[]>;
    crossBatchWineIds?: string[];
  }) {
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          // The snapshot, read BEFORE the revert RPC.
          return chain({
            data: opts.snapshotRows.map((r) => ({ ...r, lwin_id: null, lwin_score: null })),
            error: null,
          });
        }
        // Every subsequent import_batch_rows read is an "other batch"
        // cross-check inside findReferencedWineIds.
        return chain({ data: (opts.crossBatchWineIds ?? []).map((id) => ({ applied_wine_id: id })), error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) {
              // clearBatchLwinStamps' read — these cleanup-focused tests
              // never send a qualifying lwin row, so it never gets here,
              // but answer harmlessly in case that changes.
              return chain({ data: [], error: null });
            }
            return chain({ data: opts.wineRows.map((w) => ({ id: w.id, created_at: w.created_at })), error: null });
          },
          delete: () => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;
                return builder;
              },
              select: async () => {
                // The CAS guard's `.eq("updated_at", ...)` (Sol audit round
                // 6, finding 1) compares against the exact created_at value
                // this mock's own SELECT just returned for the wine — these
                // fixtures never model a separate updated_at column, so the
                // CAS naturally matches whenever nothing else in the test
                // moved the wine (the common case every pre-round-6 test
                // here means). A dedicated CAS-mismatch test below builds
                // its own delete mock instead, to model a real concurrent
                // update actually changing the row between the SELECT and
                // the DELETE.
                const match = opts.wineRows.find((row) =>
                  Object.entries(filters).every(([k, v]) => {
                    const r = row as Record<string, unknown>;
                    if (k === "updated_at") return r.created_at === v;
                    return r[k] === v;
                  }),
                );
                return { data: match ? [{ id: match.id }] : [], error: null };
              },
            };
            return builder;
          },
        };
      }
      const refs = opts.referencedByTable?.[table] ?? [];
      return chain({ data: refs.map((id) => ({ wine_id: id })), error: null });
    });
    return { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
  }

  it("deletes a wine whose created_at exactly equals this batch's own apply-time snapshot, unreferenced everywhere", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 1, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
  });

  it("spares a wine still referenced by another table (e.g. inventory_items)", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      referencedByTable: { inventory_items: [WINE_ID] },
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
  });

  it("spares a wine another (non-reverting) batch's import_batch_rows still names", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      crossBatchWineIds: [WINE_ID],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.from).toHaveBeenCalledWith("import_batch_rows");
  });

  it("spares a wine whose created_at does NOT match this batch's own apply-time snapshot (timestamp-equality guard, proof against non-malicious writers only — Sol audit 2026-08-27 round 2, finding 1 — replaces the old `created_at >= batch.created_at` heuristic a bare-wine write path like src/app/api/wines/create-from-lwin/route.ts could pass without ever being this batch's own wine)", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: "2025-06-01T00:00:00.000000Z" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
  });

  it("re-checks every non-RESTRICT WINE_REFERENCING_TABLES table immediately before deleting a wine, not just in the bulk sweep (Sol audit 2026-08-27 round 5, finding 1, extended round 6, finding 1, generalized round 7, finding 1 — only the three RESTRICT WINE_REFERENCING_TABLES are trusted from the bulk sweep alone; a race there is instead caught by the DELETE's own RESTRICT-FK failure, not re-checked here)", async () => {
    // A stock_adjustments reference that only shows up on the FRESH,
    // concurrent final re-check (not the bulk sweep) must still spare the
    // wine — proves findForgeableReferencesForWine actually runs and is
    // actually honored (replaces round 2 finding 2's inventory_items
    // version of this test, which exercised a table this design no longer
    // re-checks post-bulk-sweep).
    let stockAdjustmentsCall = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        // Call 1 is the snapshot (before the RPC); every later call is an
        // "other batch" cross-check, and none of these tests have another
        // batch to find.
        if (importBatchRowsCalls === 1) {
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("wines must never be deleted — the fresh concurrent re-check finds a reference");
          },
        };
      }
      if (table === "stock_adjustments") {
        stockAdjustmentsCall += 1;
        // Bulk sweep (call 1): no references. Final concurrent re-check
        // (call 2): a reference appeared — a concurrent, cross-tenant-
        // forgeable insert in the gap between the bulk sweep and the
        // delete.
        if (stockAdjustmentsCall === 1) return chain({ data: [], error: null });
        return chain({ data: [{ wine_id: WINE_ID }], error: null });
      }
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(stockAdjustmentsCall).toBe(2);
  });

  it("spares a wine — AND the availability_events row it just gained — when a set_wine_availability call lands after the bulk sweep but is caught by the fresh concurrent re-check (Sol audit round 6, finding 1 — the BLOCK finding: availability_events was previously missing from findForgeableReferencesForWine entirely, so this exact scenario cascade-destroyed a legitimate manager action)", async () => {
    let availabilityEventsCall = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("wines must never be deleted — the fresh concurrent re-check finds a legitimate availability_events row");
          },
        };
      }
      if (table === "availability_events") {
        availabilityEventsCall += 1;
        // Bulk sweep (call 1): no events yet. Final concurrent re-check
        // (call 2): a manager's set_wine_availability landed in the gap.
        if (availabilityEventsCall === 1) return chain({ data: [], error: null });
        return chain({ data: [{ wine_id: WINE_ID }], error: null });
      }
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(availabilityEventsCall).toBe(2);
  });

  it("spares a wine when a SERVICE-ROLE open_bottles insert (POST /api/open-bottles) lands after the bulk sweep and is caught ONLY by the fresh concurrent re-check — there is no CAS backstop for this one, unlike availability_events (Sol audit round 7, finding 1 — the BLOCK finding: open_bottles, cellar_health, and pricing_recommendations were previously missing from findForgeableReferencesForWine entirely, even though a member being policy-denied from writing them directly does not stop these service-role writers)", async () => {
    let openBottlesCall = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("wines must never be deleted — the fresh concurrent re-check finds a service-role open_bottles row");
          },
        };
      }
      if (table === "open_bottles") {
        openBottlesCall += 1;
        // Bulk sweep (call 1): no open bottle yet. Final concurrent
        // re-check (call 2): POST /api/open-bottles' service-role insert
        // landed in the gap — it never touches the wines row, so nothing
        // but this concurrent re-check can catch it.
        if (openBottlesCall === 1) return chain({ data: [], error: null });
        return chain({ data: [{ wine_id: WINE_ID }], error: null });
      }
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(openBottlesCall).toBe(2);
  });

  it("issues all SEVEN non-RESTRICT-table re-checks CONCURRENTLY — holds every request pending and proves all seven are ISSUED before any one of them is allowed to resolve (Sol audit round 6, finding 3, extended round 7, finding 1 — the previous version of this test only recorded .from() call ORDER via a synchronous log, which sequential awaits would satisfy just as well as a real Promise.all; this version can only pass if the implementation actually calls all seven before awaiting any. Round 7 extends the set from four to seven: open_bottles, cellar_health, and pricing_recommendations join the group as the FULL set of non-RESTRICT WINE_REFERENCING_TABLES tables, not just the RLS-gap-forgeable ones)", async () => {
    // Every table that participates in the final re-check gets a
    // "deferred" mock on its SECOND call (the first call is the bulk
    // sweep, which must resolve immediately so the sequential bulk-sweep
    // loop can finish and reach the final concurrent re-check at all) —
    // its promise is held open until this test explicitly resolves it.
    const FINAL_RECHECK_TABLES = [
      "import_batch_rows",
      "stock_adjustments",
      "bottle_closeouts",
      "availability_events",
      "open_bottles",
      "cellar_health",
      "pricing_recommendations",
    ] as const;
    const issued: string[] = [];
    const resolvers: Partial<Record<string, (result: { data: unknown; error: unknown }) => void>> = {};
    function deferredChain(table: string) {
      issued.push(table);
      const node: Record<string, unknown> = {
        select: () => node,
        eq: () => node,
        neq: () => node,
        order: () => node,
        range: () => node,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          new Promise((res) => {
            resolvers[table] = res;
          }).then(resolve, reject),
      };
      return node;
    }

    let importBatchRowsCalls = 0;
    const bulkSweepCallCounts: Partial<Record<string, number>> = {};
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          // The snapshot, before the RPC.
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        if (importBatchRowsCalls === 2) {
          // The bulk sweep's own cross-batch check — must resolve
          // immediately so the sequential bulk sweep can complete.
          return chain({ data: [], error: null });
        }
        // The final re-check's own cross-batch claim.
        return deferredChain("import_batch_rows");
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            const builder = {
              eq: () => builder,
              select: async () => ({ data: [{ id: WINE_ID }], error: null }),
            };
            return builder;
          },
        };
      }
      if ((FINAL_RECHECK_TABLES as readonly string[]).includes(table)) {
        bulkSweepCallCounts[table] = (bulkSweepCallCounts[table] ?? 0) + 1;
        return bulkSweepCallCounts[table] === 1 ? chain({ data: [], error: null }) : deferredChain(table);
      }
      // The remaining bulk-sweep-only RESTRICT WINE_REFERENCING_TABLES
      // tables (inventory_items, wine_list_items, pour_events).
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };

    const revertPromise = revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);

    // Wait until the implementation has actually issued all seven final
    // re-check requests — proving they were all STARTED (Promise.all)
    // rather than one being awaited before the next is even issued.
    await vi.waitFor(() => {
      if (issued.length < 7) throw new Error(`only ${issued.length}/7 issued so far`);
    });
    expect(new Set(issued)).toEqual(new Set(FINAL_RECHECK_TABLES));

    // Only now let them resolve — none referenced, so the wine qualifies.
    for (const table of FINAL_RECHECK_TABLES) {
      resolvers[table]!({ data: [], error: null });
    }

    const result = await revertPromise;
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 1, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
  });

  it("adds a CAS filter to the wine DELETE and treats a zero-row CAS mismatch as a skip, not a failure (Sol audit round 6, finding 1 — a legitimate mid-window mutation, e.g. set_wine_availability, bumps updated_at and must spare both the wine and its own new availability_events row)", async () => {
    const deleteFilters: Record<string, unknown> = {};
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            const builder = {
              eq: (column: string, value: unknown) => {
                deleteFilters[column] = value;
                return builder;
              },
              select: async () => {
                // Simulates the real DB: a concurrent UPDATE (e.g.
                // set_wine_availability) already moved updated_at past
                // APPLY_TS by the time this DELETE's WHERE clause
                // evaluates, so it matches zero rows even though
                // id/restaurant_id alone would have matched.
                return { data: [], error: null };
              },
            };
            return builder;
          },
        };
      }
      // No references anywhere — nothing but the CAS itself spares the wine.
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);

    // The .eq("updated_at", ...) filter was actually issued, carrying the
    // exact timestamp guard 1 matched against.
    expect(deleteFilters.updated_at).toBe(APPLY_TS);
    expect(deleteFilters.id).toBe(WINE_ID);
    expect(deleteFilters.restaurant_id).toBe(RESTAURANT_ID);

    // Zero rows deleted, but that's a skip — not counted in cleanupFailures.
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
  });

  it("skips a wine when the service-role sweep sees a forged cross-tenant import_batch_rows reference the RLS client cannot see (Sol audit 2026-08-27 round 5, finding 1(a) — import_batch_rows is itself member-insertable/updatable with an arbitrary applied_wine_id, so this cross-batch claim belongs in the forgeable group, not treated as unforgeable)", async () => {
    const rlsFrom = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("wines must never be deleted — the service client sees a forged cross-batch reference");
          },
        };
      }
      return chain({ data: [], error: null });
    });

    let serviceImportBatchRowsCalls = 0;
    const serviceFrom = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        serviceImportBatchRowsCalls += 1;
        // A member forged a row in some OTHER batch directly naming this
        // wine as applied_wine_id — invisible to the RLS client whenever
        // it belongs to a different tenant, visible to the service-role
        // sweep regardless.
        return chain({ data: [{ applied_wine_id: WINE_ID }], error: null });
      }
      return chain({ data: [], error: null });
    });

    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from: rlsFrom };
    const serviceClient = { from: serviceFrom };

    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, serviceClient as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(serviceImportBatchRowsCalls).toBeGreaterThan(0);
  });

  it("increments cleanupFailures (without setting orphanCleanupSkipped) when the service-role client is present but fails on its first real request — e.g. an invalid-but-present SUPABASE_SERVICE_ROLE_KEY, which still constructs a client (createServiceRoleClient) but fails only once actually used (Sol audit 2026-08-27 round 5, finding 3)", async () => {
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        throw new Error("boom: invalid service-role key — request rejected");
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("no delete should ever be attempted");
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 1 });
    errorSpy.mockRestore();
  });

  it("never fails the revert, and never discards a delete already counted, when a later candidate's cleanup errors (Sol audit 2026-08-27 round 2, finding 7)", async () => {
    const WINE_OK = "99999999-9999-4999-8999-999999999999";
    const WINE_BAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({
            data: [
              { applied_wine_id: WINE_OK, updated_at: APPLY_TS, lwin_id: null, lwin_score: null },
              { applied_wine_id: WINE_BAD, updated_at: APPLY_TS, lwin_id: null, lwin_score: null },
            ],
            error: null,
          });
        }
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({
              data: [
                { id: WINE_OK, created_at: APPLY_TS },
                { id: WINE_BAD, created_at: APPLY_TS },
              ],
              error: null,
            });
          },
          delete: () => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;
                return builder;
              },
              select: async () => {
                if (filters.id === WINE_BAD) throw new Error("boom: delete failed for this wine only");
                return { data: [{ id: filters.id }], error: null };
              },
            };
            return builder;
          },
        };
      }
      return chain({ data: [], error: null });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 2, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    // WINE_OK's delete succeeded and its count must survive WINE_BAD's
    // failure, not get reset to 0 — that's the whole point of finding 7.
    expect(result).toEqual({ ok: true, revertedCount: 2, orphanWinesDeleted: 1, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never fails the revert when cleanup itself errors before ever finding a candidate", async () => {
    let importBatchRowsCalls = 0;
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 3, error: null }),
      from: vi.fn((table: string) => {
        if (table === "import_batch_rows") {
          importBatchRowsCalls += 1;
          if (importBatchRowsCalls === 1) {
            return chain({
              data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }],
              error: null,
            });
          }
        }
        throw new Error("boom: cleanup query failed");
      }),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 3, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("spares a wine whose only reference hides past PostgREST's 1,000-row page (pagination fail-safe), and every paged read the cleanup path issues — every reference table in the sweep, the cross-batch check, and the candidate wine lookup, not just the one table that happened to paginate — carries BOTH .range() and .order() (Sol audit 2026-08-27 round 3, finding 8(a); loop broadened round 4, finding 7 — a hand-picked single-table check could miss a paged read elsewhere in the same sweep that silently dropped its own .order())", async () => {
    // Sol audit 2026-08-27 round 1, finding 2: max_rows truncation on a
    // reference query fails UNSAFE — wine B's single reference hidden
    // behind 1,000 rows of wine A's references made B look orphaned.
    // fetchAllRows pages until a short page; this mock serves B's
    // reference only on page 2.
    const WINE_A = "77777777-7777-4777-8777-777777777777";
    const WINE_B = "88888888-8888-4888-8888-888888888888";
    const calls: TrackedCall[] = [];
    let invPage = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          // The snapshot read — not part of the cleanup path proper (never
          // deadline-gated, and its own pagination is separately pinned by
          // "pages the applied-rows snapshot..." above), so intentionally
          // left off the tracked call log this test asserts over.
          return chain({
            data: [
              { applied_wine_id: WINE_A, updated_at: APPLY_TS, lwin_id: null, lwin_score: null },
              { applied_wine_id: WINE_B, updated_at: APPLY_TS, lwin_id: null, lwin_score: null },
            ],
            error: null,
          });
        }
        return trackedChain(calls, table, { data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return trackedChain(calls, table, {
              data: [
                { id: WINE_A, created_at: APPLY_TS },
                { id: WINE_B, created_at: APPLY_TS },
              ],
              error: null,
            });
          },
          delete: () => {
            throw new Error("wines must never be deleted — both candidates are referenced");
          },
        };
      }
      if (table === "inventory_items") {
        invPage += 1;
        if (invPage === 1) {
          return trackedChain(calls, table, { data: Array.from({ length: 1000 }, () => ({ wine_id: WINE_A })), error: null });
        }
        return trackedChain(calls, table, { data: [{ wine_id: WINE_B }], error: null });
      }
      return trackedChain(calls, table, { data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(invPage).toBe(2);

    const inventoryReads = calls.filter((c) => c.table === "inventory_items" && c.range);
    expect(inventoryReads.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);

    // Broadened assertion (finding 7): loop over EVERY recorded call —
    // every WINE_REFERENCING_TABLES table the bulk sweep + the per-wine
    // re-check touched, the cross-batch import_batch_rows check, AND the
    // candidate wine lookup — rather than hand-picking inventory_items
    // alone. Every one of them must carry both .range() and a deterministic
    // .order() naming a real column, with no exceptions.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.range, `expected ${call.table} to call .range()`).toBeDefined();
      expect(call.order, `expected ${call.table} to call .order()`).toBeDefined();
      expect(typeof call.order?.[0]).toBe("string");
      expect((call.order?.[0] as string).length).toBeGreaterThan(0);
    }
  });

  it("runs reference checks against the service-role client, not the caller's RLS-scoped client (Sol audit 2026-08-27 round 3, finding 3) — a reference invisible to the RLS client but visible to the service client still spares the wine", async () => {
    // Two DISTINCT dispatchers: `rlsFrom` stands in for the caller's own
    // tenant-scoped client (as if RLS is hiding a tenant-B
    // stock_adjustments row from tenant A), `serviceFrom` stands in for
    // the service-role client that sees every tenant's rows. If
    // cleanupOrphanWines ever ran its reference sweep against the wrong
    // one, the wine would get deleted here — this test is written so
    // that mistake fails loudly.
    const rlsFrom = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("wines must never be deleted — the service client sees a live reference");
          },
        };
      }
      // Every WINE_REFERENCING_TABLES table, on the RLS client: nothing
      // visible (as if RLS is hiding the cross-tenant row).
      return chain({ data: [], error: null });
    });

    const serviceFrom = vi.fn((table: string) => {
      if (table === "stock_adjustments") {
        // The service-role client sees a cross-tenant reference the RLS
        // client cannot.
        return chain({ data: [{ wine_id: WINE_ID }], error: null });
      }
      if (table === "import_batch_rows") return chain({ data: [], error: null });
      return chain({ data: [], error: null });
    });

    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from: rlsFrom };
    const serviceClient = { from: serviceFrom };

    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, serviceClient as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(serviceFrom).toHaveBeenCalledWith("stock_adjustments");
  });

  it("skips orphan-wine cleanup entirely (never deletes, never errors, never falls back to the RLS client) when no service-role client is available (Sol audit 2026-08-27 round 3, finding 3)", async () => {
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("wines must never be deleted when no service-role client is available");
          },
        };
      }
      throw new Error(`unexpected reference-table read on the RLS client for table ${table} — cleanup should have no-opped before reaching here`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, null);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: true, cleanupFailures: 0 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("halts the bulk reference sweep BEFORE issuing its next chunk request once CLEANUP_BUDGET_FROM_ENTRY_MS elapses MID-sweep — proved via the recorded call log, not just the truncated flag after the fact (Sol audit 2026-08-27 round 4, finding 2 — deadline now measured from revertImportBatch's own entry and checked before EVERY cleanup-path request)", async () => {
    const wineIds = [
      "11111111-1111-4aaa-8aaa-111111111111",
      "22222222-2222-4aaa-8aaa-222222222222",
      "33333333-3333-4aaa-8aaa-333333333333",
    ];

    // A monotonically-advancing fake clock, captured at revertImportBatch's
    // own ENTRY (t0 = 1,000,000). Every cleanup-path request below advances
    // the clock by STEP_MS=4,000 AFTER the deadline check that gates it has
    // already passed — modeling real per-request latency. With
    // CLEANUP_BUDGET_FROM_ENTRY_MS=20,000, the deadline (1,020,000) falls
    // strictly BETWEEN two of the bulk sweep's own chunk requests (the 5th,
    // open_bottles, still checks in at exactly 1,020,000 — not-greater-than
    // still passes; the 6th, pour_events, checks in at 1,024,000 and must
    // never fire) — not before the sweep starts and not only after it
    // finishes over budget. The snapshot read (never deadline-gated) does
    // not advance the clock at all, matching revertImportBatch's own
    // contract that it's exempt.
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const STEP_MS = 4_000;

    const calls: TrackedCall[] = [];
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          // The snapshot read — exempt from the deadline; no clock advance.
          return chain({
            data: wineIds.map((id) => ({ applied_wine_id: id, updated_at: APPLY_TS, lwin_id: null, lwin_score: null })),
            error: null,
          });
        }
        // The bulk sweep's cross-batch check.
        now += STEP_MS;
        return trackedChain(calls, table, { data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            now += STEP_MS;
            return trackedChain(calls, table, { data: wineIds.map((id) => ({ id, created_at: APPLY_TS })), error: null });
          },
          delete: () => {
            throw new Error("the deadline was already blown mid-sweep — no delete should ever be attempted");
          },
        };
      }
      now += STEP_MS;
      return trackedChain(calls, table, { data: [], error: null });
    });

    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 3, error: null }), from };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);

    expect(result).toEqual({ ok: true, revertedCount: 3, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: true, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(errorSpy).toHaveBeenCalled();

    // The call log is the actual proof: the candidate wine lookup, then
    // the cross-batch check, then the sweep's own reordered table list
    // (WINE_REFERENCING_TABLES) up through open_bottles (the 5th table) —
    // and NOTHING after it. pour_events (6th) and every table after it,
    // including the cross-tenant-forgeable stock_adjustments/
    // bottle_closeouts checked LAST (finding 1), must never appear —
    // proving the halt happened BEFORE that next request was issued, not
    // merely that the sweep was later flagged as having run over budget.
    expect(calls.map((c) => c.table)).toEqual([
      "wines",
      "import_batch_rows",
      "wine_list_items",
      "inventory_items",
      "availability_events",
      "open_bottles",
    ]);

    errorSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it("halts a single lookup's own ID-CHUNK loop BEFORE issuing its 2nd id-chunk request once the deadline elapses mid-chunk (Sol audit 2026-08-27 round 5, finding 5 — the round 4 fake-clock test only ever proved a halt at a table/candidate boundary, never an id-chunk boundary within one lookup)", async () => {
    // 150 candidate wine ids => the candidate wine lookup's own
    // fetchAllRowsForIds chunks them into two id-chunks of 100 + 50
    // (IN_CLAUSE_CHUNK_SIZE=100) — this test forces the deadline to elapse
    // exactly between those two chunk requests.
    const wineIds = Array.from({ length: 150 }, (_, i) => `wine-chunk-${i}`);
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let wineSelectCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        // Snapshot only — the flow never reaches a cross-batch check in
        // this test, since the candidate lookup itself halts first.
        return chain({
          data: wineIds.map((id) => ({ applied_wine_id: id, updated_at: APPLY_TS, lwin_id: null, lwin_score: null })),
          error: null,
        });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            wineSelectCalls += 1;
            if (wineSelectCalls === 1) {
              // 1st id-chunk (100 ids) succeeds, but consumes enough time
              // to blow the deadline before the 2nd id-chunk request.
              now += CLEANUP_BUDGET_FROM_ENTRY_MS + 1;
              return chain({ data: wineIds.slice(0, 100).map((id) => ({ id, created_at: APPLY_TS })), error: null });
            }
            throw new Error("a 2nd id-chunk request must never be issued once the deadline has passed");
          },
          delete: () => {
            throw new Error("no delete should ever be attempted — the deadline was blown mid-chunk-loop");
          },
        };
      }
      throw new Error(`unexpected reference-table read for ${table} — the candidate lookup should halt before reaching it`);
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 150, error: null }), from };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toMatchObject({ ok: true, cleanupTruncated: true, orphanWinesDeleted: 0 });
    expect(wineSelectCalls).toBe(1);
    errorSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it("halts a single reference table's own PAGE loop BEFORE issuing its 2nd page request once the deadline elapses mid-page (Sol audit 2026-08-27 round 5, finding 5 — the round 4 fake-clock test only ever proved a halt at a table/candidate boundary, never a page boundary within one table)", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let wineListItemsCalls = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({ data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: null, lwin_score: null }], error: null });
        }
        // The bulk sweep's cross-batch check — a single, empty page.
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: [], error: null });
            return chain({ data: [{ id: WINE_ID, created_at: APPLY_TS }], error: null });
          },
          delete: () => {
            throw new Error("no delete should ever be attempted — the deadline was blown mid-page-loop");
          },
        };
      }
      if (table === "wine_list_items") {
        wineListItemsCalls += 1;
        if (wineListItemsCalls === 1) {
          // A full 1,000-row page (some other wine's references — this
          // test doesn't care whose) forces fetchAllRows to request a 2nd
          // page; consume enough time first to blow the deadline before
          // that 2nd page request goes out.
          now += CLEANUP_BUDGET_FROM_ENTRY_MS + 1;
          return chain({ data: Array.from({ length: 1000 }, () => ({ wine_id: "some-other-wine" })), error: null });
        }
        throw new Error("a 2nd page request for this table must never be issued once the deadline has passed");
      }
      throw new Error(`unexpected reference-table read for ${table} — the sweep should halt before reaching it`);
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toMatchObject({ ok: true, cleanupTruncated: true, orphanWinesDeleted: 0 });
    expect(wineListItemsCalls).toBe(1);
    errorSpy.mockRestore();
    nowSpy.mockRestore();
  });
});

describe("revertImportBatch lwin unstamping", () => {
  const WINE_ID = "66666666-6666-4666-8666-666666666666";
  const APPLY_TS = "2026-01-01T00:00:05.000000Z";
  const STAMP = { lwinId: "LWIN-1234567", score: 0.85 };

  /** Builds the full `from` dispatcher for a revert unstamp call.
   * `snapshotRows` are this batch's own applied rows as read BEFORE the
   * revert RPC ran (updated_at, lwin_id, lwin_score); `wineRows` are the
   * wines' CURRENT state (as if read fresh AFTER the RPC — revert itself
   * never touches wines, so nothing here needs to simulate the RPC
   * changing them). cleanupOrphanWines' own "wines" read (columns
   * without "lwin") always returns empty — these tests are only about
   * unstamping, and giving cleanup nothing to do keeps that true without
   * every test having to say so. */
  function makeUnstampSupabase(opts: {
    snapshotRows: Array<{ applied_wine_id: string; updated_at: string; lwin_id: string | null; lwin_score: number | null }>;
    wineRows: Array<{ id: string; restaurant_id: string; lwin_id: string | null; lwin_match_score: number | null; updated_at: string }>;
  }) {
    let importBatchRowsCalls = 0;
    const updates: Array<Record<string, unknown>> = [];
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) return chain({ data: opts.snapshotRows, error: null });
        return chain({ data: [], error: null }); // no other-batch rows in these tests
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) return chain({ data: opts.wineRows, error: null });
            return chain({ data: [], error: null }); // cleanupOrphanWines: nothing to do
          },
          update: (payload: Record<string, unknown>) => {
            let filtered = opts.wineRows;
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;
                filtered = filtered.filter((row) => (row as Record<string, unknown>)[column] === value);
                return builder;
              },
              select: async () => {
                updates.push({ payload, ...filters });
                return { data: filtered.map((row) => ({ id: row.id })), error: null };
              },
            };
            return builder;
          },
        };
      }
      return chain({ data: [], error: null });
    });
    return { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from, updates };
  }

  it("clears a stamp this batch wrote when nothing else has touched the wine since", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]).toMatchObject({
      payload: { lwin_id: null, lwin_match_score: null },
      id: WINE_ID,
      restaurant_id: RESTAURANT_ID,
      lwin_id: STAMP.lwinId,
      lwin_match_score: STAMP.score,
      updated_at: APPLY_TS,
    });
  });

  it("clears a stamp that was already live on a PRE-EXISTING wine before apply ran, when apply's conflict UPDATE re-affirmed the identical pair (Sol audit 2026-08-27 round 3, finding 2 — this IS the documented contract now, not a residual bug: 'clear the LWIN linkage this batch's apply left live, whether it wrote it fresh or re-affirmed an identical pre-existing value'; recovery path is re-running LWIN matching, which restores the stamp)", async () => {
    // A pre-existing wine already carries the exact (lwin_id, score) pair
    // this row's own LWIN match would also compute — e.g. a re-imported
    // file, or a coincidental earlier stamp. apply's dedup-match UPDATE
    // still fires (ON CONFLICT DO UPDATE always runs), the CASE leaves
    // the values themselves unchanged (this row's score doesn't beat the
    // existing one), but wines_set_updated_at still bumps updated_at to
    // this row's own apply-chunk now() — the mock below models exactly
    // that: the wine's CURRENT state already matches this row's own
    // values, both because the pair was always identical AND because
    // apply's own transaction is what most recently touched updated_at.
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    // Cleared — per the documented contract, NOT an authorship claim: the
    // mechanism cannot and does not try to distinguish "apply wrote this
    // pair fresh" from "apply re-affirmed an identical pre-existing
    // pair" — both are "the linkage apply's own transaction left live,"
    // and clearing it on revert is intended behavior either way.
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(1);
  });

  it("clears using whichever of several same-wine rows actually has live values, without picking a 'highest score' winner up front (Sol audit 2026-08-27 round 2, finding 5 — round 1's max-score map and its tie nondeterminism are gone)", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [
        { applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: 0.95 },
        { applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: "LWIN-LOST", lwin_score: 0.7 },
      ],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: 0.95, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]).toMatchObject({ lwin_id: STAMP.lwinId, lwin_match_score: 0.95 });
  });

  it("leaves a wine whose current lwin differs from this batch's stamp (another writer won apply's own CASE)", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: "LWIN-OTHER", lwin_match_score: 0.95, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("leaves a wine whose current score is null (written by another path, e.g. match_lwin_batch)", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: null, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("leaves a stamp when the wine was written again AFTER this batch's apply and BEFORE this revert, even if the pair coincidentally matches (Sol audit 2026-08-27 round 2, finding 3 — the round-1 exact-pair-only check this replaces would have wrongly cleared it; the timestamp proof is what closes the RLS hole, since wines RLS grants any member unrestricted UPDATE)", async () => {
    const LATER_TS = "2026-01-01T00:05:00.000000Z";
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: LATER_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("ignores a row whose own score never cleared LWIN_APPLY_MIN_SCORE — it could never have been forwarded into wines.lwin_id by apply", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: 0.4 }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: 0.4, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    // cleanupOrphanWines still looks the wine up (any applied row is a
    // cleanup candidate, regardless of its lwin score) — this wine's
    // wineRows fixture isn't provided to the cleanup ("id, created_at")
    // read, so it comes back empty and cleanup no-ops. The lwin_score
    // gate is clearBatchLwinStamps' own, and it never reaches the wines
    // table AT ALL for its own (lwin-columns) read, since the row is
    // filtered out of qualifyingRows before any wine id is looked up.
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("never discards a clear already counted when a later candidate's update errors (Sol audit 2026-08-27 round 2, finding 7)", async () => {
    const WINE_OK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const WINE_BAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({
            data: [
              { applied_wine_id: WINE_OK, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score },
              { applied_wine_id: WINE_BAD, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score },
            ],
            error: null,
          });
        }
        return chain({ data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) {
              return chain({
                data: [
                  { id: WINE_OK, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: APPLY_TS },
                  { id: WINE_BAD, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: APPLY_TS },
                ],
                error: null,
              });
            }
            return chain({ data: [], error: null });
          },
          update: () => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;
                return builder;
              },
              select: async () => {
                if (filters.id === WINE_BAD) throw new Error("boom: update failed for this wine only");
                return { data: [{ id: filters.id }], error: null };
              },
            };
            return builder;
          },
        };
      }
      return chain({ data: [], error: null });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 2, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 2, orphanWinesDeleted: 0, lwinStampsCleared: 1, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("pages clearBatchLwinStamps' own wine lookup with .range()/.order() too, not just cleanupOrphanWines' (Sol audit 2026-08-27 round 4, finding 7 — the earlier pagination test only ever exercised the orphan-cleanup wine lookup)", async () => {
    const calls: TrackedCall[] = [];
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({
            data: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
            error: null,
          });
        }
        return trackedChain(calls, table, { data: [], error: null });
      }
      if (table === "wines") {
        return {
          select: (columns: string) => {
            if (columns.includes("lwin")) {
              return trackedChain(calls, table, {
                data: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: APPLY_TS }],
                error: null,
              });
            }
            return trackedChain(calls, table, { data: [], error: null });
          },
          update: (payload: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;
                return builder;
              },
              select: async () => ({ data: [{ id: filters.id }], error: null }),
            };
            void payload;
            return builder;
          },
        };
      }
      return trackedChain(calls, table, { data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID, supabase as never);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1, cleanupTruncated: false, orphanCleanupSkipped: false, cleanupFailures: 0 });

    // Every recorded call (cleanupOrphanWines' own candidate lookup, the
    // reference sweep it runs, AND clearBatchLwinStamps' lwin-columns wine
    // lookup) must carry both .range() and .order() — looped, not
    // hand-picked (finding 7).
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.range, `expected ${call.table} to call .range()`).toBeDefined();
      expect(call.order, `expected ${call.table} to call .order()`).toBeDefined();
    }
  });
});
