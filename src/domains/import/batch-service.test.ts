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
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return node;
}

/** A `from` mock for revertImportBatch's cleanup step that finds nothing
 * to clean up — for tests that only care about the RPC-translation
 * behavior, not the cleanup itself. */
function noopCleanupFrom() {
  return vi.fn((table: string) => {
    if (table === "import_batches") {
      return chain({ data: { created_at: "2020-01-01T00:00:00Z" }, error: null });
    }
    if (table === "import_batch_rows") {
      return chain({ data: [], error: null });
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe("revertImportBatch", () => {
  it("returns the reverted row count on success", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 4, error: null }), from: noopCleanupFrom() };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 4, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
  });

  it("translates a not-found error", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0002", message: "not found" } }) };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("translates a not-completed error", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0001", message: "not completed" } }) };
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toMatchObject({ ok: false, error: { code: "not_completed" } });
  });
});

describe("revertImportBatch orphan wine cleanup", () => {
  const WINE_ID = "55555555-5555-4555-8555-555555555555";

  /** Real filter semantics for the "wines" table only, since the
   * created_at provenance guard is expressed as query filters
   * (.eq/.gte) that only a filtering mock can actually exercise —
   * everything else in this file uses the looser `chain()` helper. */
  function winesTable(rows: Array<{ id: string; restaurant_id: string; created_at: string }>) {
    return {
      delete: () => {
        let filtered = rows;
        const builder = {
          in: (column: string, values: string[]) => {
            filtered = filtered.filter((row) => values.includes((row as Record<string, unknown>)[column] as string));
            return builder;
          },
          eq: (column: string, value: string) => {
            filtered = filtered.filter((row) => (row as Record<string, unknown>)[column] === value);
            return builder;
          },
          gte: (column: string, value: string) => {
            filtered = filtered.filter((row) => ((row as Record<string, unknown>)[column] as string) >= value);
            return builder;
          },
          select: async () => ({ data: filtered.map((row) => ({ id: row.id })), error: null }),
        };
        return builder;
      },
    };
  }

  /** Builds the full `from` dispatcher for a revert cleanup call.
   * `referencedByTable` lists, per wine-referencing table, which wine
   * ids that table has a row for. `crossBatchWineIds` lists wine ids
   * some OTHER batch's import_batch_rows.applied_wine_id still names. */
  function makeCleanupSupabase(opts: {
    batchCreatedAt: string;
    ownAppliedWineIds: string[];
    referencedByTable?: Record<string, string[]>;
    crossBatchWineIds?: string[];
    wineRows: Array<{ id: string; restaurant_id: string; created_at: string }>;
  }) {
    let importBatchRowsCalls = 0;
    const from = vi.fn((table: string) => {
      if (table === "import_batches") {
        return chain({ data: { created_at: opts.batchCreatedAt }, error: null });
      }
      if (table === "import_batch_rows") {
        importBatchRowsCalls += 1;
        if (importBatchRowsCalls === 1) {
          return chain({ data: opts.ownAppliedWineIds.map((id) => ({ applied_wine_id: id })), error: null });
        }
        return chain({ data: (opts.crossBatchWineIds ?? []).map((id) => ({ applied_wine_id: id })), error: null });
      }
      if (table === "wines") {
        return winesTable(opts.wineRows);
      }
      const refs = opts.referencedByTable?.[table] ?? [];
      return chain({ data: refs.map((id) => ({ wine_id: id })), error: null });
    });
    return { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from };
  }

  it("deletes a wine that this batch's apply step created and nothing else references", async () => {
    const supabase = makeCleanupSupabase({
      batchCreatedAt: "2026-01-01T00:00:00Z",
      ownAppliedWineIds: [WINE_ID],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: "2026-01-01T00:00:01Z" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 1, lwinStampsCleared: 0 });
  });

  it("spares a wine still referenced by another table (e.g. inventory_items)", async () => {
    const supabase = makeCleanupSupabase({
      batchCreatedAt: "2026-01-01T00:00:00Z",
      ownAppliedWineIds: [WINE_ID],
      referencedByTable: { inventory_items: [WINE_ID] },
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: "2026-01-01T00:00:01Z" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
  });

  it("spares a wine another (non-reverting) batch's import_batch_rows still names", async () => {
    const supabase = makeCleanupSupabase({
      batchCreatedAt: "2026-01-01T00:00:00Z",
      ownAppliedWineIds: [WINE_ID],
      crossBatchWineIds: [WINE_ID],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: "2026-01-01T00:00:01Z" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.from).toHaveBeenCalledWith("import_batch_rows");
  });

  it("spares a pre-existing wine (created before the batch) via the created_at provenance guard", async () => {
    // Unreferenced everywhere — the ONLY thing standing between this wine
    // and deletion is that it predates the batch, e.g. a scan or manual
    // add the apply RPC's upsert matched onto instead of creating.
    const supabase = makeCleanupSupabase({
      batchCreatedAt: "2026-01-01T00:00:00Z",
      ownAppliedWineIds: [WINE_ID],
      wineRows: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, created_at: "2025-06-01T00:00:00Z" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
  });

  it("never fails the revert when cleanup itself errors", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 3, error: null }),
      from: vi.fn(() => {
        throw new Error("boom: cleanup query failed");
      }),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 3, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("revertImportBatch lwin unstamping", () => {
  const WINE_ID = "66666666-6666-4666-8666-666666666666";
  const STAMP = { lwinId: "LWIN-1234567", score: 0.85 };

  /** Cleanup is neutralized (no applied rows), so from-call order is:
   * import_batches#1 (created_at) → import_batch_rows#1 (cleanup, empty)
   * → import_batch_rows#2 (stamped rows) → wines#1 (current stamps) →
   * import_batch_rows#3 (other batches' rows) → import_batches#2
   * (statuses, only when other rows exist) → wines#2+ (conditional
   * updates, real filter semantics). */
  function makeUnstampSupabase(opts: {
    stampedRows: Array<{ applied_wine_id: string; lwin_id: string; lwin_score: number }>;
    wineRows: Array<{ id: string; restaurant_id: string; lwin_id: string | null; lwin_match_score: number | null }>;
    otherRows?: Array<{ applied_wine_id: string; lwin_id: string; batch_id: string }>;
    otherBatches?: Array<{ id: string; status: string }>;
  }) {
    let batchesCalls = 0;
    let rowsCalls = 0;
    let winesCalls = 0;
    const updates: Array<Record<string, unknown>> = [];
    const from = vi.fn((table: string) => {
      if (table === "import_batches") {
        batchesCalls += 1;
        if (batchesCalls === 1) return chain({ data: { created_at: "2026-01-01T00:00:00Z" }, error: null });
        return chain({ data: opts.otherBatches ?? [], error: null });
      }
      if (table === "import_batch_rows") {
        rowsCalls += 1;
        if (rowsCalls === 1) return chain({ data: [], error: null });
        if (rowsCalls === 2) return chain({ data: opts.stampedRows, error: null });
        return chain({ data: opts.otherRows ?? [], error: null });
      }
      if (table === "wines") {
        winesCalls += 1;
        if (winesCalls === 1) return chain({ data: opts.wineRows, error: null });
        return {
          update: (payload: Record<string, unknown>) => {
            let filtered = opts.wineRows;
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (column: string, value: unknown) => {
                filters[column] = value;
                filtered = filtered.filter(
                  (row) => (row as Record<string, unknown>)[column] === value,
                );
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
      throw new Error(`unexpected table ${table}`);
    });
    return { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }), from, updates };
  }

  it("clears a stamp this batch wrote when nothing else justifies it", async () => {
    const supabase = makeUnstampSupabase({
      stampedRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [
        { id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score },
      ],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1 });
    expect(supabase.updates).toHaveLength(1);
    expect(supabase.updates[0]).toMatchObject({
      payload: { lwin_id: null, lwin_match_score: null },
      id: WINE_ID,
      restaurant_id: RESTAURANT_ID,
      lwin_id: STAMP.lwinId,
    });
  });

  it("leaves a wine whose current lwin differs from this batch's stamp (another writer won)", async () => {
    const supabase = makeUnstampSupabase({
      stampedRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [
        { id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: "LWIN-OTHER", lwin_match_score: 0.95 },
      ],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("leaves a score-null stamp (written by another path, e.g. match_lwin_batch)", async () => {
    const supabase = makeUnstampSupabase({
      stampedRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [
        { id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: null },
      ],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("keeps a stamp another LIVE batch's row independently justifies", async () => {
    const supabase = makeUnstampSupabase({
      stampedRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [
        { id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score },
      ],
      otherRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, batch_id: "other-batch" }],
      otherBatches: [{ id: "other-batch", status: "completed" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 0 });
    expect(supabase.updates).toHaveLength(0);
  });

  it("clears the stamp when the only other justifying batch is itself reverted", async () => {
    const supabase = makeUnstampSupabase({
      stampedRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, lwin_score: STAMP.score }],
      wineRows: [
        { id: WINE_ID, restaurant_id: RESTAURANT_ID, lwin_id: STAMP.lwinId, lwin_match_score: STAMP.score },
      ],
      otherRows: [{ applied_wine_id: WINE_ID, lwin_id: STAMP.lwinId, batch_id: "other-batch" }],
      otherBatches: [{ id: "other-batch", status: "reverted" }],
    });
    const result = await revertImportBatch(supabase as never, RESTAURANT_ID, BATCH_ID);
    expect(result).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0, lwinStampsCleared: 1 });
    expect(supabase.updates).toHaveLength(1);
  });
});
