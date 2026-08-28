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
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 4, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
  });

  it("translates a not-found error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0002", message: "not found" } }),
      from: noopCleanupFrom(),
    };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("translates a not-completed error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0001", message: "not completed" } }),
      from: noopCleanupFrom(),
    };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toMatchObject({ ok: false, error: { code: "not_completed" } });
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
    await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    const snapshotRead = callOrder.indexOf("from:import_batch_rows");
    const rpcCall = callOrder.indexOf("rpc:revert_import_batch");
    expect(snapshotRead).toBeGreaterThanOrEqual(0);
    expect(rpcCall).toBeGreaterThanOrEqual(0);
    expect(snapshotRead).toBeLessThan(rpcCall);
  });

  it("pages the applied-rows snapshot with .range AND a deterministic .order (Sol audit 2026-08-27 round 2, finding 4/6 — .range alone does not guarantee page 2 picks up where page 1 left off)", async () => {
    type TrackedCall = { table: string; range?: [number, number]; order?: [string, unknown] };
    const calls: TrackedCall[] = [];
    function trackedChain(table: string, result: { data: unknown; error: unknown }) {
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
        then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return node;
    }

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
        if (snapshotCall === 1) return trackedChain(table, { data: page1, error: null });
        if (snapshotCall === 2) return trackedChain(table, { data: page2, error: null });
        return trackedChain(table, { data: [], error: null });
      }
      if (table === "wines") return { select: () => trackedChain(table, { data: [], error: null }) };
      return trackedChain(table, { data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1300, error: null }), from };

    await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);

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
   * test that means to prove authorship must say so with matching
   * timestamps, and a test that means NOT to must say so with
   * mismatched ones. `referencedByTable` lists, per wine-referencing
   * table, which wine ids that table has a row for. `crossBatchWineIds`
   * lists wine ids some OTHER batch's import_batch_rows.applied_wine_id
   * still names. */
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
                const match = opts.wineRows.find((row) =>
                  Object.entries(filters).every(([k, v]) => (row as Record<string, unknown>)[k] === v),
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
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 1, lwinStampsCleared: 0 });
  });

  it("spares a wine still referenced by another table (e.g. inventory_items)", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      referencedByTable: { inventory_items: [WINE_ID] },
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
  });

  it("spares a wine another (non-reverting) batch's import_batch_rows still names", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      crossBatchWineIds: [WINE_ID],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.from).toHaveBeenCalledWith("import_batch_rows");
  });

  it("spares a wine whose created_at does NOT match this batch's own apply-time snapshot (provable-authorship guard — Sol audit 2026-08-27 round 2, finding 1 — replaces the old `created_at >= batch.created_at` heuristic a bare-wine write path like src/app/api/wines/create-from-lwin/route.ts could pass without ever being this batch's own wine)", async () => {
    const supabase = makeCleanupSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: "2025-06-01T00:00:00.000000Z" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
  });

  it("re-checks references for a single wine immediately before deleting it, not just in the bulk sweep", async () => {
    // A reference that only shows up on the FRESH per-wine re-check (not
    // the bulk sweep) must still spare the wine — proves the second,
    // single-wine findReferencedWineIds call actually runs and is
    // actually honored (Sol audit 2026-08-27 round 2, finding 2).
    let inventoryCall = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        // Call 1 is the snapshot (before the RPC); every later call is an
        // "other batch" cross-check inside findReferencedWineIds, and
        // none of these tests have another batch to find.
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
            throw new Error("wines must never be deleted — the fresh re-check finds a reference");
          },
        };
      }
      if (table === "inventory_items") {
        inventoryCall += 1;
        // Bulk sweep (call 1): no references. Fresh per-wine re-check
        // (call 2): a reference appeared — a concurrent inventory insert
        // in the gap between the bulk sweep and the delete.
        if (inventoryCall === 1) return chain({ data: [], error: null });
        return chain({ data: [{ wine_id: WINE_ID }], error: null });
      }
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(inventoryCall).toBe(2);
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
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    // WINE_OK's delete succeeded and its count must survive WINE_BAD's
    // failure, not get reset to 0 — that's the whole point of finding 7.
    expect(result).toEqual({ ok: true, revertedCount: 2, orphanWinesDeleted: 1, lwinStampsCleared: 0 });
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
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 3, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("spares a wine whose only reference hides past PostgREST's 1,000-row page (pagination fail-safe)", async () => {
    // Sol audit 2026-08-27 round 1, finding 2: max_rows truncation on a
    // reference query fails UNSAFE — wine B's single reference hidden
    // behind 1,000 rows of wine A's references made B look orphaned.
    // fetchAllRows pages until a short page; this mock serves B's
    // reference only on page 2.
    const WINE_A = "77777777-7777-4777-8777-777777777777";
    const WINE_B = "88888888-8888-4888-8888-888888888888";
    let invPage = 0;
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({
            data: [
              { applied_wine_id: WINE_A, updated_at: APPLY_TS, lwin_id: null, lwin_score: null },
              { applied_wine_id: WINE_B, updated_at: APPLY_TS, lwin_id: null, lwin_score: null },
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
          return chain({ data: Array.from({ length: 1000 }, () => ({ wine_id: WINE_A })), error: null });
        }
        return chain({ data: [{ wine_id: WINE_B }], error: null });
      }
      return chain({ data: [], error: null });
    });
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(invPage).toBe(2);
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
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1 });
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

  it("clears using whichever of several same-wine rows actually has live values, without picking a 'highest score' winner up front (Sol audit 2026-08-27 round 2, finding 5 — round 1's max-score map and its tie nondeterminism are gone)", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [
        { applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: 0.95 },
        { applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: "LWIN-LOST", lwin_score: 0.7 },
      ],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: 0.95, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1 });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]).toMatchObject({ lwin_id: STAMP.lwinId, lwin_match_score: 0.95 });
  });

  it("leaves a wine whose current lwin differs from this batch's stamp (another writer won apply's own CASE)", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: "LWIN-OTHER", lwin_match_score: 0.95, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("leaves a wine whose current score is null (written by another path, e.g. match_lwin_batch)", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: null, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("leaves a stamp when the wine was written again AFTER this batch's apply and BEFORE this revert, even if the pair coincidentally matches (Sol audit 2026-08-27 round 2, finding 3 — the round-1 exact-pair-only check this replaces would have wrongly cleared it; the timestamp proof is what closes the RLS hole, since wines RLS grants any member unrestricted UPDATE)", async () => {
    const LATER_TS = "2026-01-01T00:05:00.000000Z";
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score, updated_at: LATER_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("ignores a row whose own score never cleared LWIN_APPLY_MIN_SCORE — it could never have been forwarded into wines.lwin_id by apply", async () => {
    const supabase = makeUnstampSupabase({
      snapshotRows: [{ applied_wine_id: WINE_ID, updated_at: APPLY_TS, lwin_id: STAMP.lwinId, lwin_score: 0.4 }],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: 0.4, updated_at: APPLY_TS }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    // cleanupOrphanWines still looks the wine up (any applied row is a
    // cleanup candidate, regardless of its lwin score) — this wine's
    // wineRows fixture isn't provided to the cleanup ("id, created_at")
    // read, so it comes back empty and cleanup no-ops. The lwin_score
    // gate is clearBatchLwinStamps' own, and it never reaches the wines
    // table AT ALL for its own (lwin-columns) read, since the row is
    // filtered out of qualifyingRows before any wine id is looked up.
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
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
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 2, orphanWinesDeleted: 0, lwinStampsCleared: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
