// Characterization tests for the untested mutation/conflict logic in
// acceptBatch/undoBatch. Reuses the Supabase fixture already built for the
// reconcile-queue routes (src/app/api/reconcile-queue/route.test-helpers.ts)
// rather than inventing a second one, since it already models eq/is/filter/
// order plus failNext/beforeNext fault injection that this module's
// optimistic-concurrency and compensation logic needs to be exercised at all.
import { describe, expect, it } from "vitest";
import { acceptBatch, LedgerFailure, undoBatch, type LedgerAction } from "./index";
import {
  BIN_ID,
  INVENTORY_ID,
  LINEAGE_ID,
  RESTAURANT_ID,
  SCAN_ID,
  USER_ID,
  WINE_ID,
  makeSupabase,
  subjectSeed,
} from "../../app/api/reconcile-queue/route.test-helpers";

// seedFor()'s return type infers narrow field types (e.g. `lineage_id:
// null` as the literal `null`), which makes later reassignment to a
// different value a type error even though the fixture is plain mutable
// data. Widen to Record<string, unknown>[] per table so tests can freely
// set up not-yet-linked / already-changed / fabricated rows.
type Row = Record<string, unknown>;
function seedFor(): Record<string, Row[]> {
  return structuredClone(subjectSeed()) as unknown as Record<string, Row[]>;
}

function placeBinAction(): LedgerAction {
  return {
    action_type: "place_bin",
    subject_table: "inventory_items",
    subject_id: INVENTORY_ID,
    patch: { bin_id: BIN_ID },
  };
}

function matchScanAction(overrides: Partial<Record<string, unknown>> = {}): LedgerAction {
  return {
    action_type: "match_scan",
    subject_table: "invoice_scans",
    subject_id: SCAN_ID,
    patch: {
      line_index: 0,
      wine_id: WINE_ID,
      expected_line: { id: "line-1", name: "Before", lwin: "1000001" },
      ...overrides,
    },
  };
}

const BATCH_ID = "99999999-9999-4999-8999-999999999999";

function linkLineageAction(): LedgerAction {
  return {
    action_type: "link_lineage",
    subject_table: "wines",
    subject_id: WINE_ID,
    patch: { lineage_id: LINEAGE_ID },
  };
}

describe("acceptBatch", () => {
  it("places a bottle in a bin and records the audit trail (positive control)", async () => {
    const supabase = makeSupabase(seedFor());

    const result = await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [placeBinAction()]);

    expect(result.batch.action_count).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(supabase.tables.inventory_items[0]).toMatchObject({ bin_id: BIN_ID, bin_location: "A-01" });
  });

  it("rejects place_bin against a nonexistent bin before creating any batch (not_found)", async () => {
    const seed = seedFor();
    const supabase = makeSupabase(seed);

    await expect(
      acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [{
        action_type: "place_bin",
        subject_table: "inventory_items",
        subject_id: INVENTORY_ID,
        patch: { bin_id: "99999999-9999-4999-8999-999999999999" },
      }]),
    ).rejects.toMatchObject({ kind: "not_found" });
    // Pre-validation runs before createBatch: a doomed action must never
    // leave a batch/audit row behind.
    expect(supabase.tables.reconcile_batches).toHaveLength(0);
  });

  it("surfaces a bin-lookup error as an internal failure, not a false not_found", async () => {
    const supabase = makeSupabase(seedFor());
    supabase.failNext("bins", "select");

    await expect(
      acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [placeBinAction()]),
    ).rejects.toMatchObject({ kind: "internal", message: "Bin lookup failed." });
  });

  it("refuses to manually relink a wine's lineage unless the target already matches — real linking requires the RPC", async () => {
    const supabase = makeSupabase(seedFor()); // wine's lineage_id is null

    await expect(
      acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [linkLineageAction()]),
    ).rejects.toMatchObject({
      kind: "conflict",
      message: "Manual lineage linking requires a database RPC.",
    });
    expect(supabase.tables.reconcile_batches).toHaveLength(0);
  });

  it("rejects link_lineage against a lineage id that doesn't exist for this restaurant", async () => {
    const supabase = makeSupabase(seedFor());

    await expect(
      acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [{
        action_type: "link_lineage",
        subject_table: "wines",
        subject_id: WINE_ID,
        patch: { lineage_id: "99999999-9999-4999-8999-999999999999" },
      }]),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("allows link_lineage to re-confirm an already-linked lineage (the one case it can succeed) and updates the wines row", async () => {
    const seed = seedFor();
    seed.wines[0].lineage_id = LINEAGE_ID;
    const supabase = makeSupabase(seed);

    const result = await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [linkLineageAction()]);

    expect(result.actions).toHaveLength(1);
    expect(supabase.tables.wines[0].lineage_id).toBe(LINEAGE_ID);
  });

  it("rejects match_scan at an out-of-range line index", async () => {
    const supabase = makeSupabase(seedFor());

    await expect(
      acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [matchScanAction({ line_index: 5 })]),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("treats a malformed scan line entry as a conflict rather than crashing", async () => {
    const seed = seedFor();
    seed.invoice_scans[0].final_line_items = ["not-an-object"];
    const supabase = makeSupabase(seed);

    await expect(
      acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [matchScanAction({
        expected_line: "not-an-object",
      })]),
    ).rejects.toMatchObject({ kind: "conflict", message: "Scan line is invalid." });
  });

  it("matches a scan line to a wine by LWIN and rewrites only that line in place", async () => {
    const supabase = makeSupabase(seedFor());

    await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [matchScanAction()]);

    expect(supabase.tables.invoice_scans[0].final_line_items).toEqual([
      { id: "line-1", name: "Before", lwin: "1000001", wine_id: WINE_ID },
    ]);
  });

  it("does not attempt a subject write for a dismiss action, only the audit row", async () => {
    const seed = seedFor();
    const supabase = makeSupabase(seed);
    const before = { ...seed.inventory_items[0] };

    const result = await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [{
      action_type: "dismiss",
      subject_table: "inventory_items",
      subject_id: INVENTORY_ID,
      patch: {},
    }]);

    expect(result.actions[0].action_type).toBe("dismiss");
    expect(supabase.tables.inventory_items[0]).toEqual(before);
  });

  // The batch is not transactional across actions: each action is applied
  // and audited independently, and a later failure does NOT roll back an
  // earlier action's already-applied write within the same batch. That is
  // exactly why acceptBatch reports `applied` and `failed` separately on
  // the thrown LedgerFailure — this locks in that this is the real,
  // deliberate contract (see final report: flagged for human confirmation,
  // not treated as a bug, since the reporting shape exists for this).
  it("a batch is not atomic across actions: an earlier action's write survives a later action's failure, and the error reports both", async () => {
    const seed = seedFor();
    const supabase = makeSupabase(seed);
    supabase.failNext("invoice_scans", "update");

    let error: LedgerFailure | undefined;
    try {
      await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [placeBinAction(), matchScanAction()]);
    } catch (caught) {
      error = caught as LedgerFailure;
    }

    expect(error).toBeInstanceOf(LedgerFailure);
    expect(error?.kind).toBe("internal");
    const details = error?.details as { applied: unknown[]; failed: { action_type: string } };
    expect(details.applied).toHaveLength(1);
    expect(details.failed.action_type).toBe("match_scan");
    // The first action's write is NOT rolled back.
    expect(supabase.tables.inventory_items[0]).toMatchObject({ bin_id: BIN_ID });
    // The batch's own action_count reflects only what actually applied.
    expect(supabase.tables.reconcile_batches[0].action_count).toBe(1);
  });

  it("reports a compensation failure when a subject secretly changed despite the update reporting an error (self-heal cannot fix it)", async () => {
    const seed = seedFor();
    const supabase = makeSupabase(seed);
    // The real update actually applies (bin_id set) but is reported as an
    // error — modeling a dropped response after a committed write.
    supabase.failNext("inventory_items", "update", { after: true });
    // The compensating revert attempt then also fails outright, so the
    // subject is left stuck at the new value with no automatic fix.
    supabase.failNext("inventory_items", "update");

    let error: LedgerFailure | undefined;
    try {
      await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [placeBinAction()]);
    } catch (caught) {
      error = caught as LedgerFailure;
    }

    expect(error).toBeInstanceOf(LedgerFailure);
    expect(error?.message).toBe("Accept compensation failed.");
    const details = error?.details as { compensation_failures: Array<{ subject_table: string; subject_id: string }> };
    expect(details.compensation_failures).toEqual([
      { subject_table: "inventory_items", subject_id: INVENTORY_ID },
    ]);
    // The write really did land — the compensation failure is honest about
    // an inconsistency, not a false alarm.
    expect(supabase.tables.inventory_items[0]).toMatchObject({ bin_id: BIN_ID });
  });

  it("reports the batch-count finalize error, not the original failure, when both fail together", async () => {
    const seed = seedFor();
    const supabase = makeSupabase(seed);
    supabase.failNext("invoice_scans", "update");
    // While handling the match_scan failure above, the catch block's own
    // attempt to record how far the batch got (action_count) also fails.
    supabase.failNext("reconcile_batches", "update");

    let error: LedgerFailure | undefined;
    try {
      await acceptBatch(supabase as never, RESTAURANT_ID, USER_ID, [matchScanAction()]);
    } catch (caught) {
      error = caught as LedgerFailure;
    }

    expect(error).toBeInstanceOf(LedgerFailure);
    expect(error?.kind).toBe("internal");
    // Not the original "Subject update failed." — the finalize failure
    // takes precedence since it's the one that actually left state unclear.
    expect(error?.message).not.toBe("Subject update failed.");
  });
});

describe("undoBatch", () => {
  function acceptedBatchSeed() {
    const seed = seedFor();
    seed.inventory_items[0] = { ...seed.inventory_items[0], bin_id: BIN_ID, bin_location: "A-01" };
    seed.reconcile_batches = [{
      id: BATCH_ID,
      restaurant_id: RESTAURANT_ID,
      created_by: USER_ID,
      action_count: 1,
      created_at: "2026-08-19T00:00:00.000Z",
      undone_at: null,
      undone_by: null,
    }];
    seed.reconcile_actions = [{
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      batch_id: BATCH_ID,
      restaurant_id: RESTAURANT_ID,
      action_type: "place_bin",
      subject_table: "inventory_items",
      subject_id: INVENTORY_ID,
      prior_state: { bin_id: null, bin_location: null },
      new_state: { bin_id: BIN_ID, bin_location: "A-01" },
      ordinal: 0,
      created_at: "2026-08-19T00:00:00.000Z",
    }];
    return seed;
  }

  it("fails with not_found for a batch id that does not exist", async () => {
    const supabase = makeSupabase(seedFor());

    await expect(
      undoBatch(supabase as never, RESTAURANT_ID, USER_ID, "99999999-9999-4999-8999-999999999999"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses to undo a batch that was already undone", async () => {
    const seed = acceptedBatchSeed();
    seed.reconcile_batches[0].undone_at = "2026-08-20T00:00:00.000Z";
    const supabase = makeSupabase(seed);

    await expect(
      undoBatch(supabase as never, RESTAURANT_ID, USER_ID, BATCH_ID),
    ).rejects.toMatchObject({ kind: "conflict", message: "Batch already undone." });
  });

  it("surfaces an actions-read error as an internal failure", async () => {
    const seed = acceptedBatchSeed();
    const supabase = makeSupabase(seed);
    supabase.failNext("reconcile_actions", "select");

    await expect(
      undoBatch(supabase as never, RESTAURANT_ID, USER_ID, BATCH_ID),
    ).rejects.toMatchObject({ kind: "internal", message: "Actions read failed." });
  });

  it("refuses to undo when the subject changed since the action was recorded (conflict, not a silent clobber)", async () => {
    const seed = acceptedBatchSeed();
    // Someone moved the bottle to a different bin after the accept — the
    // recorded new_state no longer matches reality.
    seed.inventory_items[0].bin_id = "different-bin";
    const supabase = makeSupabase(seed);

    await expect(
      undoBatch(supabase as never, RESTAURANT_ID, USER_ID, BATCH_ID),
    ).rejects.toMatchObject({ kind: "conflict", message: "Subjects changed since reconciliation." });
    // Untouched — a detected conflict must not partially apply.
    expect(supabase.tables.inventory_items[0].bin_id).toBe("different-bin");
  });

  it("restores the prior state and closes the batch on a clean undo", async () => {
    const seed = acceptedBatchSeed();
    const supabase = makeSupabase(seed);

    const closed = await undoBatch(supabase as never, RESTAURANT_ID, USER_ID, BATCH_ID);

    expect(closed.undone_by).toBe(USER_ID);
    expect(supabase.tables.inventory_items[0]).toMatchObject({ bin_id: null, bin_location: null });
  });

  it("reports a real compensation failure when a restore secretly applies but cannot be verified or re-fixed", async () => {
    const seed = acceptedBatchSeed();
    const supabase = makeSupabase(seed);
    // The restore write actually reverts the row to prior_state, but the
    // response is reported as an error.
    supabase.failNext("inventory_items", "update", { after: true });
    // The subsequent compensating re-apply (putting it back to new_state)
    // then also fails outright — genuinely stuck, must be reported.
    supabase.failNext("inventory_items", "update");

    let error: LedgerFailure | undefined;
    try {
      await undoBatch(supabase as never, RESTAURANT_ID, USER_ID, BATCH_ID);
    } catch (caught) {
      error = caught as LedgerFailure;
    }

    expect(error).toBeInstanceOf(LedgerFailure);
    expect(error?.message).toBe("Undo restoration failed.");
    const details = error?.details as { compensation_failures: Array<{ subject_table: string; subject_id: string }> };
    expect(details.compensation_failures).toEqual([
      { subject_table: "inventory_items", subject_id: INVENTORY_ID },
    ]);
    // The row is left at prior_state (the restore actually landed) even
    // though the batch is not marked undone — the failure is honest.
    expect(supabase.tables.inventory_items[0]).toMatchObject({ bin_id: null, bin_location: null });
    expect(supabase.tables.reconcile_batches[0].undone_at).toBeNull();
  });

  it("reports a batch-close compensation failure when closing the batch secretly applies but cannot be verified or reverted", async () => {
    const seed = acceptedBatchSeed();
    const supabase = makeSupabase(seed);
    // The batch-close write actually sets undone_at/undone_by, but the
    // response is reported as an error.
    supabase.failNext("reconcile_batches", "update", { after: true });
    // The compensating revert (clearing undone_at back to null) then also
    // fails outright.
    supabase.failNext("reconcile_batches", "update");

    let error: LedgerFailure | undefined;
    try {
      await undoBatch(supabase as never, RESTAURANT_ID, USER_ID, BATCH_ID);
    } catch (caught) {
      error = caught as LedgerFailure;
    }

    expect(error).toBeInstanceOf(LedgerFailure);
    expect(error?.message).toBe("Batch close failed.");
    const details = error?.details as { batch_compensation_failure: { batch_id: string } };
    expect(details.batch_compensation_failure).toEqual({ batch_id: BATCH_ID });
    // Since the close itself failed, undoBatch compensates by reverting
    // the subject's restore too — the whole undo is rolled back to leave
    // the world as if it never started, except for the batch bookkeeping,
    // which really is left inconsistent (that's the reported failure).
    expect(supabase.tables.inventory_items[0]).toMatchObject({ bin_id: BIN_ID, bin_location: "A-01" });
    expect(supabase.tables.reconcile_batches[0].undone_at).not.toBeNull();
  });
});
