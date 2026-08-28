// G1-4 — import batch lifecycle: confirm, apply (chunked, resumable),
// resolve, revert. Every function here takes the caller's session-scoped
// supabase client and always filters by restaurantId explicitly, in
// addition to (never instead of) the RLS policies added in 0076 — the
// same belt-and-suspenders pattern src/lib/reconcile-ledger uses.
//
// P3 (2026-08-23-p3-chunked-import.md) additions: content-hash re-upload
// idempotency (§2.2, C09), optional session/chunk context (§3.2), and the
// count_import_batch_rows/create_import_batch RPCs (§5, C03/C09) replacing
// the two uncapped/non-atomic client-side calls this file used to make.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { buildImportPreview, type PreviewRow } from "./preview-service";
import { APPLY_CHUNK_SIZE, CLEANUP_BUDGET_FROM_ENTRY_MS, LWIN_APPLY_MIN_SCORE } from "./constants";

function summarize(rows: PreviewRow[]) {
  return {
    totalRows: rows.length,
    validRows: rows.filter((r) => r.rowState === "valid").length,
    errorRows: rows.filter((r) => r.rowState === "error").length,
    matchedRows: rows.filter((r) => r.lwinStatus === "matched").length,
    unmatchedRows: rows.filter((r) => r.rowState === "valid" && r.lwinStatus === "unmatched").length,
    missingCostRows: rows.filter((r) => r.rowState === "valid" && r.costStatus === "missing").length,
    readyToApplyRows: rows.filter((r) => r.resolution === "auto").length,
    pendingResolutionRows: rows.filter((r) => r.resolution === "pending").length,
  };
}

export type ConfirmBatchOptions = {
  /** P3 §3.2: this chunk belongs to a multi-batch onboarding session. */
  sessionId?: string;
  chunkIndex?: number;
  chunkTotal?: number;
  /** P3 §2.3: sha256 of the pre-split ORIGINAL file, from the chunk's own
   * manifest (scripts/validate-bulk-import.ts's PerChunkManifest.
   * source_csv_sha256) — checked against the session's own source_sha256
   * to reject a chunk from the wrong file being mixed in. Never confused
   * with content_sha256 (this SPECIFIC chunk's own bytes), which is
   * always computed server-side below, never client-supplied. */
  sourceSha256?: string;
};

export type ConfirmBatchResult =
  | { ok: true; alreadyExists: false; batchId: string; totalRows: number; summary: ReturnType<typeof summarize> }
  /** P3 §2.2 (C09): the exact bytes (or the same session+chunk_index)
   * were already confirmed as a live (non-reverted) batch — a resume
   * pointer, not a bare rejection. Re-applying is already idempotent
   * (§2.1), so the client's correct move is "call /apply on batchId
   * again," never "upload again." sessionId is the EXISTING batch's own
   * session (null if it has none) — the caller must compare this against
   * whatever session it thinks it's uploading into, since a content-hash
   * match can point at a batch from a completely different session. */
  | { ok: true; alreadyExists: true; batchId: string; status: string; sessionId: string | null; counts: BatchCounts }
  | { ok: false; error: { code: string; message: string; missingHeaders?: string[] } };

type RowPayload = {
  row_number: number;
  raw: Json;
  row_state: string;
  validation_errors: Json;
  lwin_status: string;
  lwin_id: string | null;
  lwin_score: number | null;
  cost_status: string;
  resolution: string;
  duplicate_reason: Json | null;
};

/**
 * Confirm an import: re-derives the full preview from the uploaded file
 * (never trusts a client-supplied preview) and persists it as one batch +
 * N rows via the create_import_batch RPC (0107) — a single function call
 * whose implicit transaction wraps the batch insert, the rows insert, and
 * tier-2 duplicate flagging together. A rows-insert failure rolls back the
 * batch insert too (C09): a failed confirm can never leave an orphaned,
 * empty batch behind.
 *
 * content_sha256 is computed here, over the RAW fileBuffer, BEFORE
 * buildImportPreview's internal decodeCsvBuffer() call ever runs — hashing
 * post-decode text could let two byte-for-byte-different uploads collide,
 * or the same file hash differently across two decode passes (§2.2).
 */
export async function confirmImportBatch(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  userId: string,
  filename: string,
  fileBuffer: Buffer,
  options: ConfirmBatchOptions = {},
): Promise<ConfirmBatchResult> {
  const preview = await buildImportPreview(supabase, fileBuffer);
  if (!preview.ok) {
    return { ok: false, error: preview.error };
  }
  if (preview.rows.length === 0) {
    return { ok: false, error: { code: "empty_file", message: "CSV has no data rows." } };
  }

  const contentSha256 = createHash("sha256").update(fileBuffer).digest("hex");

  const rowsPayload: RowPayload[] = preview.rows.map((row) => ({
    row_number: row.rowNumber,
    raw: row.raw as unknown as Json,
    row_state: row.rowState,
    validation_errors: row.errors as unknown as Json,
    lwin_status: row.lwinStatus,
    lwin_id: row.lwinId,
    lwin_score: row.lwinScore,
    cost_status: row.costStatus,
    resolution: row.resolution,
    duplicate_reason: row.duplicateReason as unknown as Json | null,
  }));

  const { data, error } = await supabase.rpc("create_import_batch", {
    p_restaurant_id: restaurantId,
    p_created_by: userId,
    p_filename: filename,
    p_total_rows: preview.rows.length,
    p_rows: rowsPayload,
    p_session_id: options.sessionId ?? null,
    p_chunk_index: options.chunkIndex ?? null,
    p_chunk_total: options.chunkTotal ?? null,
    p_content_sha256: contentSha256,
    p_source_sha256: options.sourceSha256 ?? null,
  } as never);

  if (error) {
    const pgError = error as { code?: string; message?: string };

    if (pgError.code === "23505") {
      const existing = await findDuplicateBatch(supabase, restaurantId, contentSha256, options);
      if (existing) return existing;
      // A 23505 means SOME row already satisfies the unique index — if we
      // can't find it, fail loudly rather than silently reporting success.
      throw error;
    }
    if (pgError.code === "P0002") {
      return { ok: false, error: { code: "session_not_found", message: pgError.message ?? "Import session not found." } };
    }
    if (pgError.code === "P0006") {
      return { ok: false, error: { code: "session_source_mismatch", message: pgError.message ?? "Chunk source file does not match this session." } };
    }
    throw error;
  }

  const batchId = (data as { batchId: string }).batchId;
  return {
    ok: true,
    alreadyExists: false,
    batchId,
    totalRows: preview.rows.length,
    summary: summarize(preview.rows),
  };
}

/** Looks up the pre-existing live batch a 23505 from create_import_batch
 * must be referring to — either a content_sha256 match (works with or
 * without a session) or, failing that, a (session_id, chunk_index) match.
 * Returns null only if neither lookup finds anything, which the caller
 * treats as "fail loudly" rather than silently swallowing the conflict. */
async function findDuplicateBatch(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  contentSha256: string,
  options: ConfirmBatchOptions,
): Promise<ConfirmBatchResult | null> {
  const { data: byHash } = await supabase
    .from("import_batches")
    .select("id, status, session_id")
    .eq("restaurant_id", restaurantId)
    .eq("content_sha256", contentSha256)
    .neq("status", "reverted")
    .maybeSingle();

  let match = byHash as { id: string; status: string; session_id: string | null } | null;

  if (!match && options.sessionId && options.chunkIndex !== undefined) {
    const { data: byChunk } = await supabase
      .from("import_batches")
      .select("id, status, session_id")
      .eq("session_id", options.sessionId)
      .eq("chunk_index", options.chunkIndex)
      .neq("status", "reverted")
      .maybeSingle();
    match = byChunk as { id: string; status: string; session_id: string | null } | null;
  }

  if (!match) return null;

  const counts = await countBatchRows(supabase, match.id);
  return { ok: true, alreadyExists: true, batchId: match.id, status: match.status, sessionId: match.session_id, counts };
}

export type BatchCounts = {
  total: number;
  applied: number;
  excluded: number;
  pending: number;
  eligibleNotApplied: number;
};

/** C03 (db audit 2026-08-23): replaces the old uncapped
 * `.select("apply_status, resolution").eq("batch_id", batchId)` (silently
 * truncated by PostgREST's 1,000-row max_rows past 1,000 rows, causing a
 * false status='completed') with the count_import_batch_rows RPC (0106) —
 * a single-row aggregate, immune to the row cap by construction. */
async function countBatchRows(
  supabase: SupabaseClient<Database>,
  batchId: string,
): Promise<BatchCounts> {
  const { data, error } = await supabase.rpc("count_import_batch_rows", {
    p_batch_id: batchId,
  } as never);
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as
    | { total: number; applied: number; excluded: number; pending: number; eligible_not_applied: number }
    | undefined;

  return {
    total: row?.total ?? 0,
    applied: row?.applied ?? 0,
    excluded: row?.excluded ?? 0,
    pending: row?.pending ?? 0,
    eligibleNotApplied: row?.eligible_not_applied ?? 0,
  };
}

/** Pure projection from row counts to the batch's convenience status. */
export function deriveBatchStatus(counts: BatchCounts): "created" | "applying" | "completed" {
  const settled = counts.applied + counts.excluded;
  if (settled === counts.total && counts.pending === 0 && counts.eligibleNotApplied === 0) {
    return "completed";
  }
  if (counts.applied > 0) return "applying";
  return "created";
}

async function recomputeBatchStatus(
  supabase: SupabaseClient<Database>,
  batchId: string,
): Promise<{ status: "created" | "applying" | "completed"; counts: BatchCounts }> {
  const counts = await countBatchRows(supabase, batchId);
  const status = deriveBatchStatus(counts);
  const { error } = await supabase
    .from("import_batches")
    .update({ status } as never)
    .eq("id", batchId)
    .neq("status", "reverted");
  if (error) throw error;
  return { status, counts };
}

export type ApplyChunkOutcome = {
  rowId: string;
  rowNumber: number;
  outcome: "applied" | "blocked" | "error";
  inventoryItemId: string | null;
  errorMessage: string | null;
};

export type ApplyChunkResult = {
  processed: ApplyChunkOutcome[];
  status: "created" | "applying" | "completed";
  counts: BatchCounts;
};

/**
 * Apply up to APPLY_CHUNK_SIZE eligible rows. Safe to call repeatedly —
 * on a crash, a timeout, or a deliberate pause, whatever wasn't
 * processed stays `not_applied` and is picked up by the next call; an
 * already-applied row is never revisited (FOR UPDATE SKIP LOCKED at the
 * DB layer also makes two concurrent calls for the same batch safe).
 * C03 (db audit 2026-08-23): apply_import_batch_chunk_v2 (0108) now also
 * no-ops on a REVERTED batch — calling this after a revert can never
 * recreate the inventory the operator just undid.
 */
export async function applyImportBatchChunk(
  supabase: SupabaseClient<Database>,
  batchId: string,
): Promise<ApplyChunkResult> {
  const { data, error } = await supabase.rpc("apply_import_batch_chunk", {
    p_batch_id: batchId,
    p_limit: APPLY_CHUNK_SIZE,
  } as never);
  if (error) throw error;

  const processed = ((data ?? []) as Array<{
    row_id: string;
    row_number: number;
    outcome: string;
    inventory_item_id: string | null;
    error_message: string | null;
  }>).map((r) => ({
    rowId: r.row_id,
    rowNumber: r.row_number,
    outcome: r.outcome as ApplyChunkOutcome["outcome"],
    inventoryItemId: r.inventory_item_id,
    errorMessage: r.error_message,
  }));

  const { status, counts } = await recomputeBatchStatus(supabase, batchId);

  return { processed, status, counts };
}

export type ResolveAction = "include" | "exclude";

export type ResolveRowResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

/**
 * Operator resolution for a row sitting in the pending bucket — unmatched
 * LWIN, missing cost, or (P3 §1.5) a flagged duplicate. `include` on a
 * missing-cost row requires an explicit, positive manualUnitCost — there
 * is no path that lets a row apply with a silently-defaulted cost.
 */
export async function resolveImportBatchRow(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  userId: string,
  rowId: string,
  action: ResolveAction,
  manualUnitCost?: number,
): Promise<ResolveRowResult> {
  const { data: row, error: fetchError } = await supabase
    .from("import_batch_rows")
    .select("id, batch_id, resolution, cost_status")
    .eq("id", rowId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!row) return { ok: false, error: { code: "not_found", message: "Row not found." } };

  const current = row as { id: string; batch_id: string; resolution: string; cost_status: string };
  if (current.resolution !== "pending") {
    return { ok: false, error: { code: "not_pending", message: "Row is not awaiting resolution." } };
  }

  const patch: Record<string, unknown> = {
    resolution: action,
    resolved_at: new Date().toISOString(),
    resolved_by: userId,
  };

  if (action === "include" && current.cost_status === "missing") {
    if (manualUnitCost === undefined || !Number.isFinite(manualUnitCost) || manualUnitCost < 0) {
      return {
        ok: false,
        error: { code: "manual_cost_required", message: "A non-negative unit cost is required to include this row." },
      };
    }
    patch.manual_unit_cost = Math.round(manualUnitCost * 100) / 100;
  }

  const { error: updateError } = await supabase
    .from("import_batch_rows")
    .update(patch as never)
    .eq("id", rowId)
    .eq("restaurant_id", restaurantId);
  if (updateError) throw updateError;

  await recomputeBatchStatus(supabase, current.batch_id);

  return { ok: true };
}

export type BulkResolveResult =
  | { ok: true; resolved: number; remainingPending: number }
  | { ok: false; error: { code: string; message: string } };

/**
 * Bulk operator resolution for every row in one batch's pending bucket.
 * `include` deliberately touches ONLY cost-present rows — a missing-cost
 * row still requires the per-row path with an explicit manualUnitCost
 * (resolveImportBatchRow), preserving the "no silently-defaulted cost"
 * invariant verbatim. `exclude` covers every pending row regardless of
 * cost state. Counts are derived from exact count queries before/after,
 * never from an UPDATE's returned row list (PostgREST truncates returned
 * rows at max_rows — the C03 lesson).
 */
export async function bulkResolveImportBatchRows(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  userId: string,
  batchId: string,
  action: ResolveAction,
): Promise<BulkResolveResult> {
  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, status")
    .eq("id", batchId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return { ok: false, error: { code: "not_found", message: "Import batch not found." } };
  if ((batch as { status: string }).status === "reverted") {
    return { ok: false, error: { code: "reverted", message: "A reverted batch cannot be resolved." } };
  }

  const eligible = supabase
    .from("import_batch_rows")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("restaurant_id", restaurantId)
    .eq("resolution", "pending");
  const { count: before, error: beforeError } =
    action === "include" ? await eligible.eq("cost_status", "present") : await eligible;
  if (beforeError) throw beforeError;

  const update = supabase
    .from("import_batch_rows")
    .update({
      resolution: action,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
    } as never)
    .eq("batch_id", batchId)
    .eq("restaurant_id", restaurantId)
    .eq("resolution", "pending");
  const { error: updateError } =
    action === "include" ? await update.eq("cost_status", "present") : await update;
  if (updateError) throw updateError;

  const { count: after, error: afterError } = await supabase
    .from("import_batch_rows")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("restaurant_id", restaurantId)
    .eq("resolution", "pending");
  if (afterError) throw afterError;

  await recomputeBatchStatus(supabase, batchId);

  return { ok: true, resolved: before ?? 0, remainingPending: after ?? 0 };
}

export type RevertBatchResult =
  | {
      ok: true;
      revertedCount: number;
      orphanWinesDeleted: number;
      lwinStampsCleared: number;
      /** Sol audit 2026-08-27 round 3, finding 5 (deadline arithmetic
       * corrected round 4 — see CLEANUP_BUDGET_FROM_ENTRY_MS) — true when
       * the TS-layer cleanup phase (cleanupOrphanWines /
       * clearBatchLwinStamps) hit the deadline and stopped issuing new
       * cleanup requests before finishing every candidate. The counts
       * above are still accurate for whatever DID get processed — never
       * reset or estimated — this flag only says more candidates were
       * left untouched. Re-running revert is not meaningful (the batch is
       * already reverted), so the recovery path is the same as any other
       * cleanup shortfall: re-run LWIN matching / a manual cleanup pass. */
      cleanupTruncated: boolean;
      /** Sol audit 2026-08-27 round 4, finding 6 — true when
       * `serviceClient` was unavailable (SUPABASE_SERVICE_ROLE_KEY missing
       * or misconfigured), so `cleanupOrphanWines` skipped orphan-wine
       * deletion ENTIRELY for this revert rather than running its
       * cross-tenant reference checks on the wrong client (see
       * `cleanupOrphanWines`'s own header). This is independent of
       * `cleanupTruncated`: it names a config problem, not a time budget
       * one, and it says nothing about `clearBatchLwinStamps`, which needs
       * no service-role client and still ran normally. `orphanWinesDeleted`
       * is 0 whenever this is true, but the reverse isn't implied — a
       * batch can legitimately have zero orphan wines to delete with this
       * flag false. See docs/runbooks/csv-import.md for the required env
       * var and the recovery path (re-run cleanup once the service-role
       * client is configured; the inventory revert itself already
       * succeeded and is not affected). */
      orphanCleanupSkipped: boolean;
      /** Sol audit 2026-08-27 round 5, finding 3 — count of every caught
       * cleanup-phase error this call swallowed: the applied-rows snapshot
       * read failing, cleanupOrphanWines' or clearBatchLwinStamps' own
       * top-level catch (e.g. a serviceClient that constructs fine but
       * fails on its first real request — an invalid-but-present
       * SUPABASE_SERVICE_ROLE_KEY, distinct from `orphanCleanupSkipped`,
       * which only ever means the client was null/absent), and every
       * per-candidate delete/update failure counted by either function's
       * own `failures`. NOT incremented for a `CleanupDeadlineExceededError`
       * (that's `cleanupTruncated`'s job, not a failure) or for a
       * RESTRICT-FK skip that's simply not the caller's own delete. A
       * revert that reports `cleanupFailures > 0` still `ok: true` — the
       * inventory revert itself succeeded — but some cleanup step needs a
       * manual follow-up pass; see docs/runbooks/csv-import.md. */
      cleanupFailures: number;
    }
  | { ok: false; error: { code: string; message: string } };

/** One import_batch_rows row's apply-time state, captured BEFORE
 * revert_import_batch runs (see revertImportBatch's header for why the
 * ordering is load-bearing). `updated_at` is the timestamp apply_import_
 * batch_chunk (0108) itself set, in the SAME transaction/call as the
 * wines upsert it performed for this row — the fact the whole design
 * below rests on. */
type AppliedRowSnapshot = {
  id: string;
  applied_wine_id: string | null;
  updated_at: string;
  lwin_id: string | null;
  lwin_score: number | null;
};

/** Revert a batch. C-new-1 (db audit 2026-08-23): revert_import_batch_v2
 * (0109) relaxed the guard from "status = completed" to "status <>
 * reverted" — a partially-applied, abandoned batch (or one that never got
 * past 'created') can now be reverted too, not only a fully-completed
 * one. See revert_import_batch (0109) for the exact deletion scope
 * guarantee, unchanged by this relaxation.
 *
 * revert_import_batch only ever deletes the inventory it created — never
 * wines, since a batch row's applied_wine_id may point at a pre-existing
 * wine the apply RPC's upsert matched onto (see wines_dedup_idx), and
 * deleting that would destroy data shared with other batches/scans/manual
 * adds. After the RPC succeeds, best-effort clean up wines/stamps left
 * live by this specific revert's own batch (see cleanupOrphanWines /
 * clearBatchLwinStamps below for exactly what that means and what it
 * does not prove). Cleanup failure must never fail the revert — the
 * revert already succeeded — so both steps are caught and logged, never
 * rethrown.
 *
 * `serviceClient` (Sol audit 2026-08-27 round 3, finding 3): a
 * service-role client, used ONLY by cleanupOrphanWines' reference-
 * existence checks (the bulk sweep and the fresh pre-delete re-check) —
 * never for the snapshot read, the RPC call, or the wine DELETE itself,
 * all three of which stay on the caller's RLS-scoped `supabase` (tenant-
 * scoped, so the DELETE can never itself cross tenants). This is load-
 * bearing, not a preference: stock_adjustments' insert policy checks only
 * the caller's OWN membership + self-attribution (`is_member(restaurant_id)
 * and acting_user_id = auth.uid()`) — it never checks that `wine_id`
 * belongs to that same restaurant (supabase/schema.snapshot.sql, "members
 * insert own stock_adjustments") — and `wine_id` is `ON DELETE CASCADE`.
 * So a tenant-B member can insert a stock_adjustments row naming tenant
 * A's wine_id; A's reference sweep, run on A's own RLS-scoped client,
 * cannot see that row (it's a tenant-B row); Postgres referential-
 * integrity actions bypass row security entirely, so A's wine DELETE
 * would cascade-destroy tenant B's row anyway if the sweep never saw it.
 * A service-role client sees every tenant's rows, closing exactly that
 * gap. `bottle_closeouts` has the identical shape (member insert,
 * `restaurant_id`-only check, nullable `open_bottle_id`, `wine_id` cascade
 * — see WINE_REFERENCING_TABLES). If `serviceClient` is unavailable
 * (misconfigured environment — SUPABASE_SERVICE_ROLE_KEY missing, Sol
 * audit round 4, finding 6), cleanupOrphanWines skips deletion entirely
 * rather than falling back to the RLS client — falling back would silently
 * reintroduce this exact cross-tenant risk — and the result's
 * `orphanCleanupSkipped` flag says so explicitly rather than leaving the
 * caller to infer it from a zero count.
 *
 * TOCTOU WINDOW (Sol audit 2026-08-27 round 5, finding 1 — narrowed
 * further, corrects round 4's analysis, still not closed): round 4
 * believed the fresh, single-wine re-check reduced the forgeable window
 * to "a single round-trip" by running `stock_adjustments`/
 * `bottle_closeouts` LAST inside a sequential findReferencedWineIds call.
 * That belief was wrong twice over: (a) it treated the cross-batch
 * `import_batch_rows` claim — checked FIRST in that same call — as
 * unforgeable, but `import_batch_rows` is itself member-insertable and
 * -updatable with an arbitrary `applied_wine_id` (see
 * WINE_REFERENCING_TABLES' "THESE TWO ARE NOT THE ONLY FORGEABLE TABLE"
 * comment), so the actual forgeable window for THAT table was ~9
 * sequential round-trips, not the "safe to check first" round 4 assumed;
 * (b) `stock_adjustments` and `bottle_closeouts`, checked one after the
 * other with an `await` between them, left a real one-round-trip window
 * for whichever ran first, not zero.
 *
 * The fix: findForgeableReferencesForWine now checks all THREE forgeable
 * tables (the cross-batch `import_batch_rows` claim, `stock_adjustments`,
 * `bottle_closeouts`) CONCURRENTLY via `Promise.all`, as the single final
 * step immediately before the DELETE — no other await in between. The
 * seven remaining WINE_REFERENCING_TABLES tables are trusted from the
 * bulk sweep alone (see cleanupOrphanWines' own header, "WHAT THE FINAL
 * RE-CHECK COVERS, AND WHY THE REST DON'T NEED IT," for why a race there
 * is harmless by construction — RESTRICT-FK or RPC-gated same-tenant-only
 * — rather than merely unlikely). This shrinks the residual window to ONE
 * PARALLEL round-trip for all three tables at once, replacing what was
 * actually ~9 sequential round-trips for the worst of the three under
 * round 4's design. It does NOT close the window: a forged insert landing
 * in that one parallel round-trip is still possible in principle. What
 * makes the residual acceptable rather than merely small differs slightly
 * by table: for `stock_adjustments`/`bottle_closeouts`, the ONLY way a
 * cross-tenant row can exist there at all is by exploiting the
 * pre-existing gap in those two tables' own INSERT policies (neither
 * checks that `wine_id` belongs to the inserting tenant's own
 * `restaurant_id` — see WINE_REFERENCING_TABLES' comment), and `wine_id`
 * is `ON DELETE CASCADE`, so losing that race means that forged row is
 * destroyed — no product code path this app ships ever writes a
 * cross-tenant `wine_id`, so any row that shows up there naming another
 * tenant's wine is necessarily a deliberate, malicious insert exploiting
 * that gap, not innocent concurrent activity, and the forger is the only
 * party who could lose it. For `import_batch_rows`, the same "only a
 * policy-gap exploit could get a row there" reasoning applies, but the
 * consequence of losing the race is strictly milder: `applied_wine_id` is
 * `ON DELETE SET NULL`, not CASCADE, so a forged row that loses the race
 * has its `applied_wine_id` silently nulled, not destroyed. The airtight
 * fixes are both migration-gated and out of reach for this TS-layer-only
 * pass: an ownership `WITH CHECK` on all three tables' write policies
 * (closing the underlying gaps directly), or moving the re-check and the
 * DELETE into one `SECURITY INVOKER` RPC transaction (closing the window
 * itself, not just narrowing it). See "Cross-tenant reference checks run
 * on the service-role client" in docs/runbooks/csv-import.md for the
 * live-tested proof and the tracked status of both fixes.
 *
 * A FOURTH forgeable table, and a CAS on the DELETE itself (Sol audit
 * round 6, finding 1): `availability_events` (`ON DELETE CASCADE`) was
 * missing from findForgeableReferencesForWine entirely, and the danger
 * there isn't a malicious forgery like the three above — it's a
 * genuinely legitimate one. A manager calling set_wine_availability in
 * this exact window is not exploiting any policy gap (that RPC is
 * SECURITY DEFINER, derives restaurant_id from the wine itself, and
 * requires an owner/manager of that same restaurant), yet the wine
 * DELETE would cascade away the audit event it just wrote. This function
 * now checks `availability_events` CONCURRENTLY alongside the other
 * three (four tables total, still ONE parallel page-read — see
 * findForgeableReferencesForWine's own comment). That alone still leaves
 * the same one-round-trip gap this whole section is about, so
 * cleanupOrphanWines' DELETE also gained a compare-and-swap:
 * `.eq("updated_at", <the exact timestamp guard 1 matched>)`. Verified
 * against the schema: `set_wine_availability` UPDATEs `wines` (setting
 * `is_eightysixed`) BEFORE it INSERTs the `availability_events` row
 * (supabase/schema.snapshot.sql, the function body), and
 * `wines_set_updated_at` fires on every UPDATE unconditionally — so that
 * manager's action bumps `updated_at` strictly before its own event
 * exists, and the CAS filter (comparing against the pre-mutation
 * timestamp) matches zero rows, sparing both the wine and the event it
 * just gained. This closes the gap for any writer whose own INSERT is
 * preceded by a `wines` UPDATE — currently just `set_wine_availability` —
 * but does nothing for the other three forgeable tables' own INSERT
 * paths, none of which touch the `wines` row at all
 * (`stock_adjustments`, `bottle_closeouts`, `import_batch_rows` all
 * insert into their own table only): those three still depend entirely
 * on the concurrent Promise.all re-check above, unchanged by the CAS. A
 * zero-row CAS result is treated as a skip (not incremented into
 * `deleted`), never as a failure — see cleanupOrphanWines' own DELETE
 * call for exactly that. See "Cleanup is bounded" in
 * docs/runbooks/csv-import.md for the residual this narrows to.
 *
 * CRITICAL ORDERING (Sol audit 2026-08-27, round 2): the snapshot read
 * below MUST happen BEFORE the revert_import_batch RPC call, not after.
 * revert_import_batch (0109) itself sets `updated_at = now()` on every
 * row it reverts — reading the snapshot afterward would destroy the exact
 * apply-time evidence cleanupOrphanWines/clearBatchLwinStamps depend on.
 * Neither the snapshot read nor the RPC call is ever subject to
 * `cleanupDeadline` below — the deadline governs only the best-effort
 * cleanup phase that runs after both have already completed.
 *
 * The snapshot read is itself wrapped in try/catch (Sol audit 2026-08-27
 * round 3, finding 4): it supports best-effort cleanup ONLY, so a failure
 * reading it must never block the revert RPC itself — the inventory
 * revert is the operation the caller actually asked for. On failure,
 * snapshot is treated as null and BOTH cleanup phases are skipped
 * (reported as zero, not attempted), but the RPC still runs and its
 * result is still returned. */
export async function revertImportBatch(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
  serviceClient: SupabaseClient<Database> | null,
): Promise<RevertBatchResult> {
  // Captured at ENTRY (Sol audit 2026-08-27 round 4, finding 2) — NOT
  // after the snapshot read/RPC, which round 3's version did. A slow
  // snapshot read (paginated, unbounded page count) or a slow RPC call
  // could otherwise eat most of this budget's own UX-latency ceiling
  // before cleanup's own clock even started, leaving cleanup a deadline
  // that looked like 20s of real budget but was actually much less. (Sol
  // round 5, finding 4: this budget bounds operator-facing latency, not a
  // hard platform timeout — the route's `maxDuration = 30` is inert on
  // Railway, this app's actual deployment target. See
  // CLEANUP_BUDGET_FROM_ENTRY_MS's own comment for the full arithmetic
  // and the corrected reasoning.)
  const cleanupDeadline = Date.now() + CLEANUP_BUDGET_FROM_ENTRY_MS;
  const orphanCleanupSkipped = serviceClient === null;

  let snapshotRows: AppliedRowSnapshot[] | null = null;
  let cleanupFailures = 0;
  try {
    snapshotRows = await fetchAllRows<AppliedRowSnapshot>((from, to) =>
      supabase
        .from("import_batch_rows")
        .select("id, applied_wine_id, updated_at, lwin_id, lwin_score")
        .eq("batch_id", batchId)
        .eq("restaurant_id", restaurantId)
        .eq("apply_status", "applied")
        .order("id", { ascending: true })
        .range(from, to),
    );
  } catch (snapshotError) {
    console.error(
      `revertImportBatch: applied-rows snapshot read failed for batch ${batchId}; the revert RPC still runs, but orphan-wine cleanup and LWIN unstamping will be skipped for this revert`,
      snapshotError,
    );
    snapshotRows = null;
    cleanupFailures += 1;
  }

  const { data, error } = await supabase.rpc("revert_import_batch", {
    p_batch_id: batchId,
  } as never);

  if (error) {
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === "P0002") {
      return { ok: false, error: { code: "not_found", message: "Import batch not found." } };
    }
    if (pgError.code === "P0001") {
      return { ok: false, error: { code: "not_completed", message: "Import batch is already reverted." } };
    }
    throw error;
  }

  let orphanWinesDeleted = 0;
  let lwinStampsCleared = 0;
  let cleanupTruncated = false;

  if (snapshotRows) {
    try {
      const result = await cleanupOrphanWines(supabase, serviceClient, restaurantId, batchId, snapshotRows, cleanupDeadline);
      orphanWinesDeleted = result.deleted;
      cleanupTruncated = cleanupTruncated || result.truncated;
      cleanupFailures += result.failures;
      if (result.failures > 0) {
        console.error(
          `revertImportBatch: cleanupOrphanWines skipped ${result.failures} candidate(s) after a per-wine error for batch ${batchId}; ${result.deleted} confirmed delete(s) still counted`,
        );
      }
      if (result.truncated) {
        console.error(
          `revertImportBatch: cleanupOrphanWines hit CLEANUP_BUDGET_FROM_ENTRY_MS for batch ${batchId}; stopped early with ${result.deleted} confirmed delete(s), cleanupTruncated=true`,
        );
      }
    } catch (cleanupError) {
      console.error(`revertImportBatch: orphan wine cleanup failed for batch ${batchId}`, cleanupError);
      cleanupFailures += 1;
    }

    try {
      const result = await clearBatchLwinStamps(supabase, restaurantId, batchId, snapshotRows, cleanupDeadline);
      lwinStampsCleared = result.cleared;
      cleanupTruncated = cleanupTruncated || result.truncated;
      cleanupFailures += result.failures;
      if (result.failures > 0) {
        console.error(
          `revertImportBatch: clearBatchLwinStamps skipped ${result.failures} candidate(s) after a per-wine error for batch ${batchId}; ${result.cleared} confirmed clear(s) still counted`,
        );
      }
      if (result.truncated) {
        console.error(
          `revertImportBatch: clearBatchLwinStamps hit CLEANUP_BUDGET_FROM_ENTRY_MS for batch ${batchId}; stopped early with ${result.cleared} confirmed clear(s), cleanupTruncated=true`,
        );
      }
    } catch (unstampError) {
      console.error(`revertImportBatch: lwin unstamp failed for batch ${batchId}`, unstampError);
      cleanupFailures += 1;
    }
  }

  return {
    ok: true,
    revertedCount: (data as number | null) ?? 0,
    orphanWinesDeleted,
    lwinStampsCleared,
    cleanupTruncated,
    orphanCleanupSkipped,
    cleanupFailures,
  };
}

/** Sol audit 2026-08-27 round 4, finding 2 — thrown by fetchAllRows/
 * fetchAllRowsForIds/findReferencedWineIds when a `deadline` they were
 * given has already passed, checked BEFORE issuing the next request
 * rather than after. Every caller in the cleanup path (cleanupOrphanWines,
 * clearBatchLwinStamps) catches this specifically and stops — never
 * counts it as a per-candidate failure — and sets `truncated: true`. It
 * is never thrown by the snapshot read or the revert RPC call, neither of
 * which is ever given a deadline (see revertImportBatch's header). */
class CleanupDeadlineExceededError extends Error {}

function assertBeforeDeadline(deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() > deadline) {
    throw new CleanupDeadlineExceededError();
  }
}

/** PostgREST silently caps any un-ranged select at max_rows (1000,
 * supabase/config.toml). For the orphan/unstamp safety checks below that
 * truncation FAILS UNSAFE: a hidden 1,001st reference row could make a
 * still-referenced wine look orphaned (Sol audit 2026-08-27 round 1,
 * finding 2). Every reference read therefore pages with .range() AND
 * carries a deterministic .order() — .range() alone does not guarantee a
 * stable row order across calls, so two pages without an explicit order
 * can overlap or skip rows entirely (Sol audit 2026-08-27 round 2,
 * finding 4). Callers supply the order clause themselves (the column
 * differs per table) — this helper only owns the paging loop.
 *
 * `deadline` (Sol audit 2026-08-27 round 4, finding 2) is OPTIONAL and,
 * when given, is checked before EVERY page request this loop issues —
 * not just once per caller. The snapshot read in revertImportBatch calls
 * this with no deadline at all (it must never be truncated); every
 * cleanup-path caller passes one. */
const POSTGREST_PAGE = 1000;
async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  deadline?: number,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += POSTGREST_PAGE) {
    assertBeforeDeadline(deadline);
    const { data, error } = await page(from, from + POSTGREST_PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < POSTGREST_PAGE) return all;
  }
}

/** Sol audit 2026-08-27 round 3, finding 5(a) — MAX_ROWS allows batches up
 * to 5,000 applied rows, so a single `.in(candidateIds)` query built from
 * every candidate at once could carry ~4,000 UUIDs (~156,000 characters)
 * in one request URL. Every `.in()` query built from a candidate-id array
 * below is chunked to this size first. */
const IN_CLAUSE_CHUNK_SIZE = 100;
function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + IN_CLAUSE_CHUNK_SIZE));
  }
  return chunks;
}

/** Runs `page` once per (id chunk, PostgREST page) — the id chunking
 * above composed with fetchAllRows' own 1,000-row page cap, since a
 * single 100-id chunk can still legitimately match more than 1,000 rows
 * in a busy referencing table (e.g. many stock_adjustments rows for one
 * wine). `deadline` (Sol audit 2026-08-27 round 4, finding 2), when
 * given, is checked before EVERY id-chunk's request boundary in addition
 * to fetchAllRows' own per-page check — so a candidate lookup or
 * reference sweep built from many id chunks (up to 50 for a 5,000-row
 * batch at IN_CLAUSE_CHUNK_SIZE) can never issue chunk 2 once the
 * deadline has already passed while chunk 1 was in flight. */
async function fetchAllRowsForIds<T>(
  ids: string[],
  page: (idsChunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  deadline?: number,
): Promise<T[]> {
  const all: T[] = [];
  for (const chunk of chunkIds(ids)) {
    assertBeforeDeadline(deadline);
    const rows = await fetchAllRows<T>((from, to) => page(chunk, from, to), deadline);
    all.push(...rows);
  }
  return all;
}

/** Every table (besides import_batch_rows itself) with a wines(id) FK.
 * Verified against supabase/schema.snapshot.sql — keep in sync if a
 * migration adds another one. Of these, `stock_adjustments` and
 * `bottle_closeouts` are member-insertable directly, and neither INSERT
 * RLS policy checks that `wine_id` belongs to the SAME restaurant_id
 * being inserted — `stock_adjustments` checks only `is_member(
 * restaurant_id) and acting_user_id = auth.uid()`, `bottle_closeouts`
 * only `is_member(restaurant_id)` — so either can carry a caller-chosen
 * `wine_id` from ANY tenant, and `wine_id` is `ON DELETE CASCADE` on
 * both. See findReferencedWineIds' `serviceClient` requirement below for
 * why that combination matters.
 *
 * THESE TWO ARE NOT THE ONLY FORGEABLE TABLE (Sol audit 2026-08-27 round
 * 5, finding 1(a) — corrects round 4's claim): `import_batch_rows` itself
 * is ALSO member-insertable and -updatable with an arbitrary
 * `applied_wine_id` — "members can create import batch rows" and
 * "members can update import batch rows" (supabase/schema.snapshot.sql)
 * check only `is_member_with_role(restaurant_id, 'staff')`, never that
 * `applied_wine_id` belongs to that same restaurant or was ever legitimately
 * applied there. Round 4's framing ("rows there are written only by
 * apply_import_batch_chunk and revert_import_batch, never by a direct
 * member insert") was simply false. The cross-batch `import_batch_rows`
 * claim findReferencedWineIds checks is therefore a THIRD forgeable
 * reference, not a safe-to-check-first one — see findReferencedWineIds'
 * own comment for how all three are now handled together. One difference
 * from the other two: `applied_wine_id` is `ON DELETE SET NULL`, not
 * CASCADE — a forged row racing the DELETE has its `applied_wine_id`
 * silently nulled, not destroyed. `stock_adjustments`/`bottle_closeouts`
 * rows, by contrast, are destroyed outright by the CASCADE. Both
 * consequences are named here so neither is understated: nulling a
 * forged row a same-tenant-or-cross-tenant attacker doesn't legitimately
 * own is a shrug; the cascade destruction is the one worth closing at the
 * RLS layer (see below).
 *
 * These three are the only ones forgeable via an RLS-policy gap.
 * `availability_events` joined the final re-check group in round 6
 * (finding 1) for an unrelated reason — its own INSERT path has no such
 * gap — see findForgeableReferencesForWine's own comment. */
const WINE_REFERENCING_TABLES = [
  "wine_list_items",
  "inventory_items",
  "availability_events",
  "open_bottles",
  "pour_events",
  "pricing_recommendations",
  "cellar_health",
  "stock_adjustments",
  "bottle_closeouts",
] as const;

// The four FORGEABLE tables — import_batch_rows' cross-batch
// applied_wine_id claim, stock_adjustments, bottle_closeouts (see
// WINE_REFERENCING_TABLES' "THESE TWO ARE NOT THE ONLY FORGEABLE TABLE"
// note), and availability_events (Sol audit round 6, finding 1 — added
// for a legitimate-concurrent-activity reason, not an RLS-gap exploit
// like the other three; see findForgeableReferencesForWine's own
// comment) — get one more check each: findForgeableReferencesForWine
// below re-checks all four CONCURRENTLY, immediately before a
// candidate's DELETE, which ALSO carries a CAS guard against the exact
// timestamp guard 1 matched (cleanupOrphanWines' own header). The bulk
// sweep (findReferencedWineIds) still checks all four too, alongside the
// other six non-forgeable WINE_REFERENCING_TABLES, to build the initial
// orphan candidate set.

/** Every table/row in WINE_REFERENCING_TABLES, plus any OTHER (non-
 * reverting) batch's own import_batch_rows.applied_wine_id claims, that
 * still names one of `wineIds`. Used by cleanupOrphanWines' BULK sweep
 * only, to build the initial candidate set across every wine at once —
 * see findForgeableReferencesForWine below for the final, per-candidate,
 * immediately-pre-DELETE re-check (Sol audit round 5, finding 1).
 *
 * `serviceClient` MUST be service-role, never the caller's RLS-scoped
 * client (Sol audit 2026-08-27 round 3, finding 3): `stock_adjustments`
 * and `bottle_closeouts` are both member-insertable with only a
 * same-tenant self-check, not a same-tenant `wine_id` check (see
 * WINE_REFERENCING_TABLES' own comment) — a tenant-B member can insert a
 * row naming tenant A's wine_id. Tenant A's RLS-scoped client can never
 * see that tenant-B row (RLS hides it), so a reference check run on A's
 * own client would call the wine unreferenced and delete it — and
 * Postgres' `ON DELETE CASCADE` bypasses row security entirely when it
 * fires, destroying tenant B's row along with it. A service-role client
 * sees every tenant's rows, so this check (and the DELETE decision it
 * feeds) is correct regardless of which tenant wrote the referencing row.
 * The wine DELETE itself still runs on the caller's own RLS-scoped
 * client (see revertImportBatch's header) — only this existence check
 * needs service-role visibility.
 *
 * BULK-PHASE ONLY (Sol audit 2026-08-27 round 5, finding 1 — replaces
 * round 4's "request order is load-bearing" framing for THIS function):
 * this function is now used only to build the initial orphan-candidate
 * set from the full batch of wines, never as the final, immediately-
 * pre-DELETE re-check for a single wine — that job belongs to
 * findForgeableReferencesForWine below. Because nothing here runs
 * immediately before a DELETE anymore, the request order within this
 * function carries no TOCTOU consequence and is kept in a simple, stable
 * shape: the cross-batch `import_batch_rows` claim first, then every
 * WINE_REFERENCING_TABLES table in the array's own order. (Round 4 had
 * claimed the cross-batch check was safe to run first because
 * "import_batch_rows is never cross-tenant forgeable" — false:
 * `import_batch_rows` is itself member-insertable/-updatable with an
 * arbitrary `applied_wine_id`, same as `stock_adjustments`/
 * `bottle_closeouts` — see WINE_REFERENCING_TABLES' own comment. That
 * error is why the final pre-DELETE re-check was split out into its own,
 * concurrent function instead of continuing to rely on this one's
 * ordering.) `deadline` (Sol audit round 4, finding 2) is threaded into
 * every paged request below via fetchAllRowsForIds, so a slow reference
 * table still gets this function to stop (throwing
 * CleanupDeadlineExceededError) before issuing its next chunk request
 * rather than running unboundedly. */
async function findReferencedWineIds(
  serviceClient: SupabaseClient<Database>,
  wineIds: string[],
  excludeBatchId: string,
  deadline: number,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (wineIds.length === 0) return referenced;

  const otherBatchRows = await fetchAllRowsForIds<{ applied_wine_id: string | null }>(
    wineIds,
    (idsChunk, from, to) =>
      serviceClient
        .from("import_batch_rows")
        .select("applied_wine_id")
        .in("applied_wine_id", idsChunk)
        .neq("batch_id", excludeBatchId)
        .order("id", { ascending: true })
        .range(from, to),
    deadline,
  );
  for (const row of otherBatchRows) {
    if (row.applied_wine_id) referenced.add(row.applied_wine_id);
  }

  for (const table of WINE_REFERENCING_TABLES) {
    const refs = await fetchAllRowsForIds<{ wine_id: string }>(
      wineIds,
      (idsChunk, from, to) =>
        serviceClient
          .from(table)
          .select("wine_id")
          .in("wine_id", idsChunk)
          .order("wine_id", { ascending: true })
          .range(from, to),
      deadline,
    );
    for (const row of refs) referenced.add(row.wine_id);
  }

  return referenced;
}

/** The final, single-wine, immediately-pre-DELETE re-check (Sol audit
 * 2026-08-27 round 5, finding 1 — replaces the round-4 design, which
 * reused findReferencedWineIds for this and relied on request ORDER
 * within it to shrink the TOCTOU window; that design had two bugs: (a)
 * it treated the cross-batch `import_batch_rows` claim as unforgeable and
 * ran it FIRST, ~9 requests away from the DELETE, when it is in fact just
 * as forgeable as `stock_adjustments`/`bottle_closeouts` — see
 * WINE_REFERENCING_TABLES' own comment; (b) `stock_adjustments` and
 * `bottle_closeouts` were checked sequentially, one AWAITED request after
 * the other, so even between themselves the claimed "one round-trip
 * window" was actually two).
 *
 * This function checks all FOUR forgeable tables — the cross-batch
 * `import_batch_rows` claim, `stock_adjustments`, `bottle_closeouts`, and
 * (Sol audit round 6, finding 1) `availability_events` — CONCURRENTLY via
 * `Promise.all`, and nothing else: the other six WINE_REFERENCING_TABLES
 * are checked ONLY in the bulk sweep (findReferencedWineIds), never
 * re-checked here, because a race in any of them is either same-tenant-
 * only (no product code path writes a cross-tenant `wine_id`) or `ON
 * DELETE RESTRICT` rather than CASCADE (`inventory_items`,
 * `wine_list_items`, `pour_events`) — a concurrent insert there simply
 * makes the DELETE that follows fail loudly (caught per-wine by
 * cleanupOrphanWines' own try/catch, counted as a failure, never silently
 * losing data), so re-checking them here would spend a request to
 * prevent an outcome the DELETE itself already prevents safely.
 * `availability_events` USED to sit in that "harmless" bucket on the
 * reasoning that it's RPC-gated to the wine's own tenant — true, but
 * irrelevant to the actual harm: `set_wine_availability` is a genuine,
 * same-tenant, non-malicious manager action, and losing that race would
 * cascade-delete the audit event it just wrote, not merely let a forger
 * lose a row they had no right to. It moved into this function's group
 * for that reason (round 6, finding 1), not because its own INSERT path
 * turned out to share the other three's RLS-gap shape — it doesn't.
 *
 * Calling code MUST await this function's result, check it, and issue the
 * DELETE with no other await in between (cleanupOrphanWines does exactly
 * that, and — round 6, finding 1 — also adds a CAS filter to that same
 * DELETE, closing the gap for whichever forgeable table's own writer
 * happens to touch the `wines` row before its own insert; see
 * cleanupOrphanWines' own header) — the residual window this leaves is
 * the single parallel round-trip between this function's `Promise.all`
 * resolving and the DELETE request going out, for all four tables at
 * once, not a sequential ~9-10 round-trip window for whichever forgeable
 * table happened to run first. */
async function findForgeableReferencesForWine(
  serviceClient: SupabaseClient<Database>,
  wineId: string,
  excludeBatchId: string,
  deadline: number,
): Promise<boolean> {
  const [crossBatchRows, stockAdjustmentRows, bottleCloseoutRows, availabilityEventRows] = await Promise.all([
    fetchAllRows<{ applied_wine_id: string | null }>(
      (from, to) =>
        serviceClient
          .from("import_batch_rows")
          .select("applied_wine_id")
          .eq("applied_wine_id", wineId)
          .neq("batch_id", excludeBatchId)
          .order("id", { ascending: true })
          .range(from, to),
      deadline,
    ),
    fetchAllRows<{ wine_id: string }>(
      (from, to) =>
        serviceClient
          .from("stock_adjustments")
          .select("wine_id")
          .eq("wine_id", wineId)
          .order("wine_id", { ascending: true })
          .range(from, to),
      deadline,
    ),
    fetchAllRows<{ wine_id: string }>(
      (from, to) =>
        serviceClient
          .from("bottle_closeouts")
          .select("wine_id")
          .eq("wine_id", wineId)
          .order("wine_id", { ascending: true })
          .range(from, to),
      deadline,
    ),
    // Sol audit round 6, finding 1 — the 4th forgeable table. Unlike the
    // three above, its INSERT path isn't an RLS-policy gap: writes only
    // happen through the SECURITY DEFINER set_wine_availability RPC,
    // which correctly derives restaurant_id from the wine and requires an
    // owner/manager of THAT restaurant. It still needs re-checking here
    // because the harm isn't a forged cross-tenant row — it's a genuine,
    // same-tenant, non-malicious manager action (toggling 86'd status)
    // landing in the gap and having its audit event cascade-deleted along
    // with the wine. See cleanupOrphanWines' own header, guard 1's CAS
    // note, for why this table is also the one the CAS DELETE guard below
    // independently protects.
    fetchAllRows<{ wine_id: string }>(
      (from, to) =>
        serviceClient
          .from("availability_events")
          .select("wine_id")
          .eq("wine_id", wineId)
          .order("wine_id", { ascending: true })
          .range(from, to),
      deadline,
    ),
  ]);
  return (
    crossBatchRows.length > 0 ||
    stockAdjustmentRows.length > 0 ||
    bottleCloseoutRows.length > 0 ||
    availabilityEventRows.length > 0
  );
}

/** Deletes wines that qualify under the guards below — this batch's own
 * apply step created them (guard 1, proof against non-malicious writers
 * only — see its own note) AND nothing else currently references them
 * (guard 2). Not "and only those" in an absolute sense: see guard 1's own
 * scope note for the named, accepted non-malicious residual, and guard
 * 2's for the named cross-tenant residual the re-check narrows but does
 * not close (Sol audit 2026-08-27 round 4, finding 5 — this header
 * previously overclaimed "and ONLY those").
 * Redesigned in the Sol audit 2026-08-27 round-2 pass: round 1's
 * `wines.created_at >= batch.created_at` guard was justified by the FALSE
 * claim that every product write path creating a wine also creates a
 * referencing row in the same operation — real bare-wine paths exist
 * (src/app/api/cellar/route.ts, .../inventory/save-scan/route.ts, .../
 * wines/create-from-lwin/route.ts, the last of which never gets a
 * reference until a later, separate user action). This version checks an
 * exact timestamp equality instead of guessing a window.
 *
 * A wine qualifies for deletion only when ALL of these hold:
 *   1. some row in `snapshotRows` (this batch's applied rows, read BEFORE
 *      the revert RPC ran — see revertImportBatch's header) names it as
 *      applied_wine_id, AND that row's own `updated_at` EXACTLY equals
 *      the wine's `created_at`. apply_import_batch_chunk (0108) inserts a
 *      wine with created_at default now(), then updates that SAME row's
 *      updated_at = now() in the SAME transaction/call — one now() either
 *      way, and no product code path ever writes `created_at` directly.
 *      SCOPE OF THIS GUARD (Sol audit 2026-08-27 round 3, finding 1 —
 *      narrowed from an earlier, overclaimed "provable authorship"):
 *      this equality is proof against every NON-MALICIOUS writer. It is
 *      NOT proof against a malicious one: `wines` RLS grants members
 *      unrestricted UPDATE ("members can update their wines",
 *      supabase/schema.snapshot.sql) with no column-level restriction on
 *      `created_at`, and `import_batch_rows` is member-readable ("members
 *      can read import batch rows") — so a same-tenant member COULD read
 *      a snapshot row's `updated_at` and deliberately rewrite some other,
 *      pre-existing bare wine's `created_at` to match it, forging this
 *      guard into deleting that wine. This is deliberately NOT treated as
 *      a hole to close here: `wines` RLS ALSO grants members unrestricted
 *      DELETE on their own restaurant's wines ("members can delete their
 *      wines"), so a member willing to forge `created_at` already holds
 *      the DELETE right directly — the forgery buys them nothing they
 *      didn't already have. Closing it with new TS-layer mechanism would
 *      add complexity to defend a privilege boundary that doesn't
 *      actually move. The one accepted NON-malicious residual: two
 *      DIFFERENT apply-chunk transactions landing on the exact same
 *      microsecond timestamp — negligible, named here rather than
 *      silently assumed away. This equality is also RESTATED as a CAS on
 *      the DELETE itself (Sol audit round 6, finding 1): the exact
 *      timestamp that proved the match here is re-compared against the
 *      wine's CURRENT `updated_at` in the DELETE's own `.eq()` filter, so
 *      a mutation landing between this read and the DELETE — not just
 *      between the bulk sweep and the DELETE, guard 2's concern below —
 *      makes the DELETE match zero rows instead of proceeding on stale
 *      evidence. See cleanupOrphanWines' own DELETE call for the
 *      mechanics and why it closes the gap only for a writer whose own
 *      INSERT is preceded by a `wines` UPDATE (currently just
 *      `set_wine_availability`);
 *   2. it has zero references across every other wines(id)-referencing
 *      table (WINE_REFERENCING_TABLES) AND zero references from another
 *      batch's import_batch_rows.applied_wine_id, checked once in bulk
 *      (findReferencedWineIds, all ten checks) and then RE-CHECKED,
 *      single-wine, immediately before that wine's own DELETE — but that
 *      final re-check (Sol audit 2026-08-27 round 5, finding 1, extended
 *      round 6, finding 1 — findForgeableReferencesForWine) covers only
 *      the FOUR FORGEABLE tables (import_batch_rows' cross-batch claim,
 *      stock_adjustments, bottle_closeouts, availability_events — see
 *      WINE_REFERENCING_TABLES' own comment for why the first three
 *      qualify and findForgeableReferencesForWine's own comment for why
 *      the fourth does, for a different reason), run CONCURRENTLY via
 *      `Promise.all`, not the full ten-table sweep again. The other six
 *      tables are trusted from the bulk pass alone — see "WHAT THE FINAL
 *      RE-CHECK COVERS, AND WHY THE REST DON'T NEED IT" below. Both the
 *      bulk sweep and the final re-check run on
 *      `serviceClient` (Sol audit 2026-08-27 round 3, finding 3), never
 *      the caller's RLS-scoped client, so a cross-tenant reference in
 *      stock_adjustments or bottle_closeouts is never invisible to the
 *      check that's about to authorize a DELETE (see findReferencedWineIds'
 *      own comment for the full cascade-destruction mechanics this
 *      closes). If `serviceClient` is unavailable, this entire function
 *      no-ops (logs, returns zero, and the caller reports
 *      `orphanCleanupSkipped: true` — Sol round 4, finding 6) rather than
 *      falling back to the RLS-scoped client — falling back would
 *      silently reintroduce that cross-tenant risk.
 *
 *      WHAT THE FINAL RE-CHECK COVERS, AND WHY THE REST DON'T NEED IT
 *      (Sol audit 2026-08-27 round 5, finding 1, extended round 6,
 *      finding 1 — replaces round 4's "closing most of the window"
 *      framing, which itself rested on two errors: it called the
 *      cross-batch `import_batch_rows` claim unforgeable, and it checked
 *      `stock_adjustments`/`bottle_closeouts` sequentially rather than
 *      concurrently, so even its own "single round-trip" claim was
 *      actually two): the re-check and the DELETE are still two separate
 *      steps, so in principle ANY referencing table could receive a
 *      fresh, cascade-linked insert in the gap between them. For the six
 *      WINE_REFERENCING_TABLES tables NOT re-checked here, that gap is
 *      harmless by construction, not merely unlikely: `inventory_items`,
 *      `wine_list_items`, and `pour_events` are `ON DELETE RESTRICT`
 *      rather than CASCADE, so a concurrent insert there fails the DELETE
 *      outright instead of losing data — caught per-wine (see below) and
 *      simply skipped, never silently pretended to have succeeded;
 *      `open_bottles`, `pricing_recommendations`, and `cellar_health`
 *      have no direct-member-insert RLS policy that can name an arbitrary
 *      `wine_id` outside its own tenant. `stock_adjustments`
 *      (src/app/api/stock-adjustments/route.ts), `bottle_closeouts`, and
 *      `import_batch_rows`' own cross-batch claim are the three where
 *      that gap is genuinely forgeable in the RLS-exploit sense — the
 *      first two cross-tenant (neither requires live inventory to write,
 *      and neither RLS INSERT policy checks that `wine_id` belongs to the
 *      inserting tenant — see WINE_REFERENCING_TABLES' own comment;
 *      bottle_closeouts' own app route, src/app/api/open-bottles/close/
 *      route.ts, actually goes through the tenant-safe, inventory-gated
 *      SECURITY DEFINER `close_open_bottle` RPC (0061), but its table's
 *      OWN "members can insert bottle_closeouts" RLS policy still permits
 *      a direct REST insert bypassing that RPC entirely), the third
 *      same-tenant-or-cross-tenant (any member can insert/update an
 *      import_batch_rows row with an arbitrary `applied_wine_id` — see
 *      WINE_REFERENCING_TABLES' own comment). `availability_events` is
 *      the FOURTH member of this group (round 6, finding 1) for a
 *      different reason: its INSERT path has no RLS gap at all —
 *      `set_wine_availability` is SECURITY DEFINER, derives its own
 *      `restaurant_id` from the wine, and requires an owner/manager of
 *      THAT restaurant — but it IS `ON DELETE CASCADE`, and the writer
 *      landing in this gap is a genuinely legitimate same-tenant action,
 *      not an attacker. `findForgeableReferencesForWine` checks all four
 *      CONCURRENTLY, immediately before the DELETE that follows a
 *      successful re-check — shrinking this residual from what round 4
 *      wrongly measured as "~1 round-trip for 2 of 3 tables, ~9 for the
 *      third" down to one PARALLEL round-trip for all four. The DELETE
 *      itself also carries the CAS guard from guard 1 above (round 6,
 *      finding 1), which independently closes the remaining one-
 *      round-trip gap for `availability_events` specifically — its
 *      writer (`set_wine_availability`) always touches the `wines` row
 *      before inserting its event, so the CAS catches what the
 *      concurrent re-check's own timing might still miss; the other
 *      three forgeable tables' writers never touch `wines`, so for them
 *      the concurrent re-check remains the only defense.
 *
 *      Why the narrowed residual is accepted, for the three RLS-gap
 *      tables, rather than requiring an airtight close here: for
 *      `stock_adjustments`/`bottle_closeouts`, the ONLY way a
 *      cross-tenant row can occupy that final gap at all is by exploiting
 *      the pre-existing gap in those two tables' own INSERT policies — no
 *      product code path this app ships ever writes a `wine_id` outside
 *      its own tenant, so any row that shows up there naming another
 *      tenant's wine is necessarily a deliberate malicious insert
 *      exploiting that policy gap, never innocent concurrent activity;
 *      the forger is the only party who can lose that row, and only by
 *      choosing to exploit a vulnerability that already lets them attach
 *      arbitrary rows to a wine they don't own. For `import_batch_rows`,
 *      the consequence of losing that race is strictly milder: the FK is
 *      `ON DELETE SET NULL`, not CASCADE (see WINE_REFERENCING_TABLES'
 *      own comment), so a forged row racing the DELETE has its
 *      `applied_wine_id` silently nulled, never destroyed — and the only
 *      party who could plant such a row there in the first place is,
 *      again, exploiting `import_batch_rows`' own INSERT/UPDATE policy
 *      gap, which grants them nothing new. Airtight closure needs either
 *      an ownership `WITH CHECK` on all three tables' write policies
 *      (closing the underlying gaps directly, not just this window) or
 *      moving the re-check and the DELETE into one `SECURITY INVOKER` RPC
 *      transaction (closing the window itself) — both are migration-gated
 *      and out of reach for this TS-layer-only pass; see
 *      docs/runbooks/csv-import.md, "Cross-tenant reference checks run on
 *      the service-role client," for the tracked status. For
 *      `availability_events`, the residual after the CAS guard is
 *      narrower still: only a legitimate `set_wine_availability` call
 *      landing in the single remaining gap between
 *      findForgeableReferencesForWine's own `Promise.all` resolving and
 *      the DELETE request going out — after that point the CAS itself
 *      protects it — which is the
 *      same order of residual as the microsecond-timestamp-collision
 *      residual named in guard 1;
 *   3. it belongs to the reverting restaurant (explicit filter, matching
 *      this file's belt-and-suspenders pattern — never rely on RLS
 *      alone).
 *
 * Per-wine delete errors are caught individually (Sol round-2 finding 7)
 * so one bad delete never discards the count already earned by wines
 * deleted earlier in the same call; `failures` is for logging only. A
 * `CleanupDeadlineExceededError` (Sol round 4, finding 2) is caught
 * separately from an ordinary per-wine error: it means `deadline` (see
 * CLEANUP_BUDGET_FROM_ENTRY_MS) passed WHILE a request was about to be
 * issued, not that any one wine's own work failed, so it sets `truncated`
 * and stops the whole loop rather than counting a `failures` entry and
 * moving on to the next candidate. `truncated` tells the caller whether
 * that happened, so counts stay accurate for whatever DID run rather than
 * being padded or estimated. */
async function cleanupOrphanWines(
  supabase: SupabaseClient<Database>,
  serviceClient: SupabaseClient<Database> | null,
  restaurantId: string,
  batchId: string,
  snapshotRows: AppliedRowSnapshot[],
  deadline: number,
): Promise<{ deleted: number; failures: number; truncated: boolean }> {
  const rowTimestampsByWine = new Map<string, Set<string>>();
  for (const row of snapshotRows) {
    if (!row.applied_wine_id) continue;
    const timestamps = rowTimestampsByWine.get(row.applied_wine_id) ?? new Set<string>();
    timestamps.add(row.updated_at);
    rowTimestampsByWine.set(row.applied_wine_id, timestamps);
  }
  const candidateWineIds = Array.from(rowTimestampsByWine.keys());
  if (candidateWineIds.length === 0) return { deleted: 0, failures: 0, truncated: false };

  if (!serviceClient) {
    console.error(
      `cleanupOrphanWines: no service-role client available for batch ${batchId}; skipping cleanup for ${candidateWineIds.length} candidate(s) rather than running cross-tenant reference checks on the RLS-scoped client`,
    );
    return { deleted: 0, failures: 0, truncated: false };
  }

  let wines: Array<{ id: string; created_at: string }>;
  try {
    wines = await fetchAllRowsForIds<{ id: string; created_at: string }>(
      candidateWineIds,
      (idsChunk, from, to) =>
        supabase
          .from("wines")
          .select("id, created_at")
          .in("id", idsChunk)
          .eq("restaurant_id", restaurantId)
          .order("id", { ascending: true })
          .range(from, to),
      deadline,
    );
  } catch (err) {
    if (err instanceof CleanupDeadlineExceededError) {
      console.error(
        `cleanupOrphanWines: soft deadline hit during the candidate wine lookup for batch ${batchId}; skipping ${candidateWineIds.length} candidate(s)`,
      );
      return { deleted: 0, failures: 0, truncated: true };
    }
    throw err;
  }

  // Guard 1: the wine's created_at exactly matches one of THIS wine's own
  // snapshot rows' updated_at (same apply-chunk transaction) — see the
  // function header for exactly what this does and does not prove.
  // `created_at` is kept alongside each qualifying wine's id (not just the
  // id) because it doubles as the CAS value the DELETE below compares
  // against — see "Guard 1 restated as a CAS" in the function header.
  const batchCreatedWines = wines.filter((wine) => rowTimestampsByWine.get(wine.id)?.has(wine.created_at));
  const batchCreatedWineIds = batchCreatedWines.map((wine) => wine.id);
  if (batchCreatedWineIds.length === 0) return { deleted: 0, failures: 0, truncated: false };
  const casTimestampByWineId = new Map(batchCreatedWines.map((wine) => [wine.id, wine.created_at]));

  // Guard 2 (bulk pass). findReferencedWineIds itself checks `deadline`
  // before every request it issues (Sol round 4, finding 2) — no separate
  // gate needed here beyond catching what it throws.
  let referenced: Set<string>;
  try {
    referenced = await findReferencedWineIds(serviceClient, batchCreatedWineIds, batchId, deadline);
  } catch (err) {
    if (err instanceof CleanupDeadlineExceededError) {
      console.error(
        `cleanupOrphanWines: soft deadline hit during the bulk reference sweep for batch ${batchId}; skipping ${batchCreatedWineIds.length} candidate(s)`,
      );
      return { deleted: 0, failures: 0, truncated: true };
    }
    throw err;
  }
  const orphanCandidates = batchCreatedWineIds.filter((id) => !referenced.has(id));

  let deleted = 0;
  let failures = 0;
  let truncated = false;
  for (const wineId of orphanCandidates) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    try {
      // Guard 2 (fresh, CONCURRENT, single-wine re-check immediately
      // before delete — Sol audit round 5, finding 1, extended round 6,
      // finding 1: see findForgeableReferencesForWine for why only the
      // four forgeable tables are re-checked here, and why that's a
      // Promise.all, not a sequential findReferencedWineIds call). No
      // other await happens between this resolving and the DELETE call
      // below besides the synchronous deadline check immediately after it.
      const stillReferenced = await findForgeableReferencesForWine(serviceClient, wineId, batchId, deadline);
      if (stillReferenced) continue;

      // One more check immediately before the DELETE itself (Sol round 4,
      // finding 2) — the re-check above can legitimately take long enough
      // on its own to cross the deadline mid-flight; this is synchronous
      // (no request, no additional round-trip), and every cleanup-path
      // request still gets a check.
      assertBeforeDeadline(deadline);

      // CAS guard (Sol audit round 6, finding 1): the DELETE itself only
      // fires when the wine's CURRENT updated_at still equals the exact
      // timestamp guard 1 matched against — the same value used to prove
      // batch-created above. wines_set_updated_at bumps updated_at on
      // EVERY update to the row (see the function header), so any
      // mutation landing between the bulk sweep's page-read and this
      // DELETE — including one whose own child-row INSERT the concurrent
      // re-check above has no way to see — makes this filter match zero
      // rows instead of the DELETE going through blind. A zero-row result
      // is a skip, not a failure: nothing is thrown, `deleted` simply
      // isn't incremented.
      const casTimestamp = casTimestampByWineId.get(wineId)!;
      const { data: deletedRows, error: deleteError } = await supabase
        .from("wines")
        .delete()
        .eq("id", wineId)
        .eq("restaurant_id", restaurantId)
        .eq("updated_at", casTimestamp)
        .select("id");
      if (deleteError) throw deleteError;
      deleted += (deletedRows ?? []).length;
    } catch (err) {
      if (err instanceof CleanupDeadlineExceededError) {
        truncated = true;
        break;
      }
      failures += 1;
      console.error(`cleanupOrphanWines: delete failed for wine ${wineId} (batch ${batchId})`, err);
    }
  }
  return { deleted, failures, truncated };
}

/** Clears the LWIN linkage this batch's apply left live on a wine, for
 * wines that survive revert (a deleted wine needs no unstamp —
 * cleanupOrphanWines always runs first, see revertImportBatch).
 *
 * CONTRACT (Sol audit 2026-08-27 round 3, finding 2 — rewritten from an
 * "authorship proof" framing that overclaimed what the mechanism below
 * actually establishes): "clear the LWIN linkage this batch's apply left
 * live" means EITHER apply's conflict UPDATE freshly wrote the pair, OR
 * it re-affirmed an identical pre-existing value — both count, and both
 * are intended behavior, not merely tolerated. Concretely: when a row's
 * apply-time dedup-match hits an EXISTING wine that already carries the
 * exact (lwin_id, lwin_match_score) pair this row's own match would also
 * write (a re-imported file, or a member/earlier-batch coincidence),
 * apply_import_batch_chunk_v2's `ON CONFLICT DO UPDATE` still runs — its
 * CASE expressions leave the SET values unchanged (this row's own score
 * doesn't beat the existing one, so nothing in the pair actually
 * changes), but the UPDATE statement itself still executes and the
 * `wines_set_updated_at` trigger still fires `updated_at = now()` in
 * THIS row's own apply-chunk transaction. That transaction genuinely
 * touched this wine and left exactly this row's own values live —
 * whether or not any byte of `lwin_id`/`lwin_match_score` actually
 * changed — so clearing it on revert is correct under the contract
 * above, not a bug. (This replaces round 1's narrower and FALSE
 * "authorship proof" claim — "a non-null lwin_match_score is only ever
 * written by a batch apply" (round 1 finding 4) — which round 2 already
 * disproved: wines RLS grants members unrestricted UPDATE ("members can
 * update their wines", supabase/schema.snapshot.sql), so any client can
 * pre-write an identical pair. Nothing in the mechanism below changed
 * for round 3 — only the claim about what it proves.)
 *
 * Recovery path for the identical-pre-existing-pair corner: if a stamp
 * gets cleared that a DIFFERENT source (not this batch) actually wanted
 * live, re-running LWIN matching against the wine restores it — the
 * match computation is idempotent and does not depend on import history.
 *
 * A wine's stamp is cleared only when, for ONE of THIS batch's own
 * qualifying snapshot rows (applied_wine_id = wine.id, lwin_id not null,
 * lwin_score >= LWIN_APPLY_MIN_SCORE — only such rows could have been
 * forwarded into wines.lwin_id by apply's 0.6 confidence gate, 0108),
 * BOTH hold:
 *   1. the wine's CURRENT updated_at (read fresh, AFTER the revert RPC —
 *      revert itself never touches wines, so this is still whatever
 *      apply last left) exactly equals that row's OWN updated_at,
 *      captured in the snapshot BEFORE revert ran. apply's wines upsert
 *      and its import_batch_rows UPDATE share one transaction/one now()
 *      (0108), so this equality shows this row's own apply-chunk call
 *      was the LAST write to this wine's row — closing the round-1 hole
 *      for a pre-write or overwrite happening AFTER apply and BEFORE
 *      this revert call (the concrete exploit that finding described):
 *      such a write carries its own, later timestamp, and this equality
 *      correctly fails against it;
 *   2. the wine's CURRENT (lwin_id, lwin_match_score) exactly equals that
 *      row's own (lwin_id, lwin_score). Needed alongside #1, not
 *      redundant with it: EVERY row that dedup-matches an EXISTING wine
 *      bumps that wine's updated_at (apply's ON CONFLICT DO UPDATE always
 *      fires the wines_set_updated_at trigger, whether or not this row's
 *      own LWIN match actually won apply's "prefers higher score"
 *      comparison) — so #1 alone would let this batch clear a stamp it
 *      merely stood NEXT TO (e.g. a higher-scoring match that arrived
 *      from another source and legitimately beat this row's own), not
 *      one whose own values are what's actually live. Requiring the
 *      current value to match this row's own value confirms apply's
 *      CASE genuinely resolved to this row's own pair, not the
 *      pre-existing one it was compared against.
 * Together, both checks still leave one named residual: a third party
 * writing the EXACT (lwin_id, lwin_match_score) pair this row's own LWIN
 * match would independently compute, BEFORE apply ran, on a wine this
 * row also dedup-matches, passes both checks by coincidence. That
 * requires guessing a specific trigram-similarity float to exact
 * precision ahead of time — accepted as negligible, the same order of
 * residual as cleanupOrphanWines' own named microsecond-timestamp-
 * collision residual.
 *
 * The UPDATE itself ALSO re-checks the row's own updated_at server-side
 * alongside the exact (lwin_id, lwin_match_score) pair (verified against
 * the live local stack — see docs/runbooks/csv-import.md), so a
 * genuinely concurrent write between this function's read and its UPDATE
 * makes the match fail and the stamp survives untouched, rather than
 * clobbering whatever that concurrent writer just wrote.
 *
 * This REPLACES round-1's "highest score wins" stamps map and its
 * associated equal-score tie nondeterminism (round-1 finding 6, round-2
 * finding 5) outright: instead of picking one candidate stamp per wine
 * ahead of time, every qualifying row for a wine is tried, and only the
 * row whose own values are actually still live (checks 1+2) ever
 * matches — there is nothing left to break ties over; whichever row the
 * database itself deterministically applied last (by row_number order,
 * inside apply_import_batch_chunk's own loop) is the one that passes.
 * It also REPLACES round-1's "another live batch justifies this stamp"
 * lookup (round-1 finding 4's unpaged query, round-2 finding 4's second
 * half): if another batch's apply genuinely won the wine after this one,
 * ITS transaction's timestamp is what's live on wines.updated_at, so
 * check 1 above already fails for this batch's row — the separate
 * justification lookup added nothing the timestamp check doesn't already
 * give for free, so it is dropped along with the unpaged status query it
 * required.
 *
 * Per-wine errors are caught individually so one failing UPDATE never
 * discards counts already earned earlier in the same call (Sol round-2
 * finding 7), same contract as cleanupOrphanWines. `deadline` / `truncated`
 * (Sol round-3 finding 5, arithmetic corrected round 4 — see
 * CLEANUP_BUDGET_FROM_ENTRY_MS): same shared soft-deadline contract as
 * cleanupOrphanWines, checked before the candidate wine lookup's own
 * request(s) and before every per-wine UPDATE, not just once — see that
 * function's header. This function does NOT need a service-role client
 * (unlike cleanupOrphanWines): it only ever reads/writes wines already
 * scoped to `restaurantId`, never checks another tenant's rows in another
 * table. */
async function clearBatchLwinStamps(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
  snapshotRows: AppliedRowSnapshot[],
  deadline: number,
): Promise<{ cleared: number; failures: number; truncated: boolean }> {
  const qualifyingRows = snapshotRows.filter(
    (row): row is AppliedRowSnapshot & { applied_wine_id: string; lwin_id: string; lwin_score: number } =>
      row.applied_wine_id !== null &&
      row.lwin_id !== null &&
      row.lwin_score !== null &&
      row.lwin_score >= LWIN_APPLY_MIN_SCORE,
  );
  if (qualifyingRows.length === 0) return { cleared: 0, failures: 0, truncated: false };

  const rowsByWine = new Map<string, typeof qualifyingRows>();
  for (const row of qualifyingRows) {
    const rows = rowsByWine.get(row.applied_wine_id) ?? [];
    rows.push(row);
    rowsByWine.set(row.applied_wine_id, rows);
  }
  const wineIds = Array.from(rowsByWine.keys());

  let wines: Array<{
    id: string;
    lwin_id: string | null;
    lwin_match_score: number | null;
    updated_at: string;
  }>;
  try {
    wines = await fetchAllRowsForIds<{
      id: string;
      lwin_id: string | null;
      lwin_match_score: number | null;
      updated_at: string;
    }>(
      wineIds,
      (idsChunk, from, to) =>
        supabase
          .from("wines")
          .select("id, lwin_id, lwin_match_score, updated_at")
          .in("id", idsChunk)
          .eq("restaurant_id", restaurantId)
          .order("id", { ascending: true })
          .range(from, to),
      deadline,
    );
  } catch (err) {
    if (err instanceof CleanupDeadlineExceededError) {
      console.error(
        `clearBatchLwinStamps: soft deadline hit during the candidate wine lookup for batch ${batchId}; skipping ${wineIds.length} candidate(s)`,
      );
      return { cleared: 0, failures: 0, truncated: true };
    }
    throw err;
  }

  let cleared = 0;
  let failures = 0;
  let truncated = false;
  for (const wine of wines) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const candidates = rowsByWine.get(wine.id) ?? [];
    // Checks 1+2: a qualifying row whose own (updated_at, lwin_id, score)
    // is EXACTLY what's currently live on the wine.
    const provenRow = candidates.find(
      (row) =>
        row.updated_at === wine.updated_at &&
        wine.lwin_id === row.lwin_id &&
        wine.lwin_match_score === row.lwin_score,
    );
    if (!provenRow) continue;

    try {
      const { data: updated, error: updateError } = await supabase
        .from("wines")
        .update({ lwin_id: null, lwin_match_score: null })
        .eq("id", wine.id)
        .eq("restaurant_id", restaurantId)
        .eq("lwin_id", provenRow.lwin_id)
        .eq("lwin_match_score", provenRow.lwin_score)
        .eq("updated_at", provenRow.updated_at)
        .select("id");
      if (updateError) throw updateError;
      cleared += (updated ?? []).length;
    } catch (err) {
      failures += 1;
      console.error(`clearBatchLwinStamps: update failed for wine ${wine.id} (batch ${batchId})`, err);
    }
  }
  return { cleared, failures, truncated };
}
