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
import { APPLY_CHUNK_SIZE, LWIN_APPLY_MIN_SCORE } from "./constants";

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
  | { ok: true; revertedCount: number; orphanWinesDeleted: number; lwinStampsCleared: number }
  | { ok: false; error: { code: string; message: string } };

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
 * adds. After the RPC succeeds, best-effort clean up wines that are
 * provably orphaned by this specific revert (see cleanupOrphanWines).
 * Cleanup failure must never fail the revert — the revert already
 * succeeded — so it's caught and logged, never rethrown. */
export async function revertImportBatch(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
): Promise<RevertBatchResult> {
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
  try {
    orphanWinesDeleted = await cleanupOrphanWines(supabase, restaurantId, batchId);
  } catch (cleanupError) {
    console.error(`revertImportBatch: orphan wine cleanup failed for batch ${batchId}`, cleanupError);
  }

  let lwinStampsCleared = 0;
  try {
    lwinStampsCleared = await clearBatchLwinStamps(supabase, restaurantId, batchId);
  } catch (unstampError) {
    console.error(`revertImportBatch: lwin unstamp failed for batch ${batchId}`, unstampError);
  }

  return { ok: true, revertedCount: (data as number | null) ?? 0, orphanWinesDeleted, lwinStampsCleared };
}

/** PostgREST silently caps any un-ranged select at max_rows (1000,
 * supabase/config.toml). For the orphan/unstamp safety checks below that
 * truncation FAILS UNSAFE: a hidden 1,001st reference row could make a
 * still-referenced wine look orphaned (Sol audit 2026-08-27, finding 2).
 * Every reference read therefore pages with .range() until a short page
 * proves exhaustion. */
const POSTGREST_PAGE = 1000;
async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += POSTGREST_PAGE) {
    const { data, error } = await page(from, from + POSTGREST_PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < POSTGREST_PAGE) return all;
  }
}

/** Every table (besides import_batch_rows itself) with a wines(id) FK.
 * Verified against supabase/schema.snapshot.sql — keep in sync if a
 * migration adds another one. */
const WINE_REFERENCING_TABLES = [
  "stock_adjustments",
  "wine_list_items",
  "inventory_items",
  "availability_events",
  "open_bottles",
  "pour_events",
  "pricing_recommendations",
  "cellar_health",
  "bottle_closeouts",
] as const;

/** Deletes wines this batch's apply step created, and ONLY those. No
 * column on import_batch_rows/wines records true created-vs-found
 * provenance (the apply RPC's wine insert is an upsert keyed on
 * wines_dedup_idx, so applied_wine_id may equally point at a wine a scan,
 * a manual add, or an earlier batch already owned) — so a wine qualifies
 * only when ALL of these hold:
 *   1. it's in this batch's own applied_wine_id set;
 *   2. it has zero references across every other wines(id)-referencing
 *      table (WINE_REFERENCING_TABLES), AND zero references from
 *      import_batch_rows.applied_wine_id belonging to any OTHER batch —
 *      this batch's own rows don't count against it, that's how the
 *      candidate set was built;
 *   3. it belongs to the reverting restaurant (explicit filter, matching
 *      this file's belt-and-suspenders pattern — never rely on RLS alone);
 *   4. wines.created_at >= this batch's created_at — a conservative
 *      stand-in for real creation provenance, NOT a proof of authorship
 *      (Sol audit 2026-08-27, finding 1): a wine created by another flow
 *      in the confirm→apply window also passes it. The residual exposure
 *      is deliberately accepted and narrow — every product write path
 *      that creates a wine (manual add, scan save, another batch's
 *      apply) also creates a referencing row in the same operation
 *      (inventory_items at minimum), so any such wine is spared by
 *      guard 2 as long as that reference lives; only a bare wine row
 *      created through the raw API with NO accompanying reference, in
 *      that window, matching this batch's exact dedup key, could be
 *      wrongly deleted. Airtight authorship needs a provenance column or
 *      a transactional SQL function — both are DB-layer changes the
 *      locked migration manifest currently forbids.
 *
 * Known non-transactional residual (Sol finding 3, accepted): the
 * reference checks and the DELETE are separate PostgREST requests, so a
 * cascade-FK child row (availability_events, open_bottles, …) inserted
 * in the sub-second window between check and delete would be destroyed
 * by the cascade. Writers of those tables act on wines with live
 * inventory; a wine that reached this point has zero inventory and zero
 * references anywhere moments earlier, so a concurrent insert requires
 * an out-of-product writer racing a revert. inventory_items is ON
 * DELETE RESTRICT, so the one realistic concurrent writer — another
 * batch's apply — makes the DELETE itself fail safely.
 *
 * Returns the count deleted; throws on any query/delete error so the
 * caller can log-and-swallow without silently pretending cleanup ran. */
async function cleanupOrphanWines(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
): Promise<number> {
  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("created_at")
    .eq("id", batchId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return 0;

  const appliedRows = await fetchAllRows<{ applied_wine_id: string | null }>((from, to) =>
    supabase
      .from("import_batch_rows")
      .select("applied_wine_id")
      .eq("batch_id", batchId)
      .not("applied_wine_id", "is", null)
      .range(from, to),
  );

  const candidateWineIds = Array.from(
    new Set(
      appliedRows
        .map((row) => row.applied_wine_id)
        .filter((id): id is string => id !== null),
    ),
  );
  if (candidateWineIds.length === 0) return 0;

  const referencedIds = new Set<string>();

  for (const table of WINE_REFERENCING_TABLES) {
    const refs = await fetchAllRows<{ wine_id: string }>((from, to) =>
      supabase
        .from(table)
        .select("wine_id")
        .in("wine_id", candidateWineIds)
        .range(from, to),
    );
    for (const row of refs) referencedIds.add(row.wine_id);
  }

  const otherBatchRows = await fetchAllRows<{ applied_wine_id: string | null }>((from, to) =>
    supabase
      .from("import_batch_rows")
      .select("applied_wine_id")
      .in("applied_wine_id", candidateWineIds)
      .neq("batch_id", batchId)
      .range(from, to),
  );
  for (const row of otherBatchRows) {
    if (row.applied_wine_id) referencedIds.add(row.applied_wine_id);
  }

  const orphanWineIds = candidateWineIds.filter((id) => !referencedIds.has(id));
  if (orphanWineIds.length === 0) return 0;

  const { data: deleted, error: deleteError } = await supabase
    .from("wines")
    .delete()
    .in("id", orphanWineIds)
    .eq("restaurant_id", restaurantId)
    .gte("created_at", (batch as { created_at: string }).created_at)
    .select("id");
  if (deleteError) throw deleteError;

  return (deleted ?? []).length;
}

/** Clears wines.lwin_id/lwin_match_score stamps this batch wrote, for
 * wines that SURVIVE the revert (orphan-deleted wines need no unstamp).
 * Sol audit 2026-08-27 (variant-matching review, finding 3): apply's
 * upsert can stamp a pre-existing wine's lwin at score >= 0.6, and
 * revert_import_batch never touches wines — so a wrong match survived
 * revert with no UI to undo it. A wine is unstamped only when ALL hold:
 *   1. one of THIS batch's rows applied it with lwin_score >=
 *      LWIN_APPLY_MIN_SCORE (only such rows can have stamped). When
 *      several of this batch's rows applied the same wine, the
 *      HIGHEST-scoring stamp is the comparison value — apply's
 *      strictly-higher rule means that is the one that can be in place
 *      (Sol round-1 finding 6);
 *   2. the wine's CURRENT (lwin_id, lwin_match_score) exactly equals
 *      that stamp. Authorship invariant (round-1 finding 4): a NON-NULL
 *      lwin_match_score is only ever written by a batch apply —
 *      match_lwin_batch (0007) sets lwin_id but never the score, so a
 *      score-null stamp is left untouched, and an exact non-null match
 *      with no live justifier (guard 3) means every possible author is
 *      this batch or an already-REVERTED batch, whose surviving stamp
 *      is precisely what this feature exists to remove. Any other
 *      current value means another writer won — left untouched;
 *   3. no OTHER non-reverted batch row applied the same wine with the
 *      same lwin_id at >= LWIN_APPLY_MIN_SCORE (it independently
 *      justifies the stamp);
 *   4. restaurant-scoped, and the DB-side UPDATE re-checks the exact
 *      (lwin_id, lwin_match_score) pair so a concurrent higher-score
 *      writer in the read→write window is never clobbered (round-1
 *      finding 5). Both values round-trip through the same PostgREST
 *      float4 serialization, so equality is faithful. The one residual
 *      race — an EQUAL-score justifier batch applying between the
 *      justification scan and the UPDATE — clears a stamp that batch
 *      re-establishes on its next apply of the same row; accepted as
 *      narrow and self-healing.
 * All reads page via fetchAllRows (max_rows truncation fails unsafe
 * here too). Returns the count cleared; throws on query errors (caller
 * logs and swallows, same contract as cleanupOrphanWines). */
async function clearBatchLwinStamps(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
): Promise<number> {
  const stampedRows = await fetchAllRows<{
    applied_wine_id: string | null;
    lwin_id: string | null;
    lwin_score: number | null;
  }>((from, to) =>
    supabase
      .from("import_batch_rows")
      .select("applied_wine_id, lwin_id, lwin_score")
      .eq("batch_id", batchId)
      .not("applied_wine_id", "is", null)
      .not("lwin_id", "is", null)
      .gte("lwin_score", LWIN_APPLY_MIN_SCORE)
      .range(from, to),
  );

  // Highest score per wine: with several rows applying the same wine,
  // apply's strictly-higher rule means the max-score stamp is the one
  // that can actually be in place on the wine.
  const stamps = new Map<string, { lwinId: string; score: number }>();
  for (const row of stampedRows) {
    if (row.applied_wine_id && row.lwin_id && row.lwin_score !== null) {
      const current = stamps.get(row.applied_wine_id);
      if (!current || row.lwin_score > current.score) {
        stamps.set(row.applied_wine_id, { lwinId: row.lwin_id, score: row.lwin_score });
      }
    }
  }
  if (stamps.size === 0) return 0;

  const wineIds = Array.from(stamps.keys());
  const wines = await fetchAllRows<{
    id: string;
    lwin_id: string | null;
    lwin_match_score: number | null;
  }>((from, to) =>
    supabase
      .from("wines")
      .select("id, lwin_id, lwin_match_score")
      .in("id", wineIds)
      .eq("restaurant_id", restaurantId)
      .range(from, to),
  );

  // Condition 2: the wine's current stamp is exactly what this batch
  // wrote. Both values round-trip through the same PostgREST float4
  // serialization, so === is a faithful comparison.
  const clearCandidates = wines.filter((wine) => {
    const stamp = stamps.get(wine.id);
    return (
      stamp !== undefined &&
      wine.lwin_id === stamp.lwinId &&
      wine.lwin_match_score !== null &&
      wine.lwin_match_score === stamp.score
    );
  });
  if (clearCandidates.length === 0) return 0;

  // Condition 3: another live batch's row justifying the same stamp.
  const candidateIds = clearCandidates.map((wine) => wine.id);
  const otherRows = await fetchAllRows<{
    applied_wine_id: string | null;
    lwin_id: string | null;
    batch_id: string;
  }>((from, to) =>
    supabase
      .from("import_batch_rows")
      .select("applied_wine_id, lwin_id, batch_id")
      .in("applied_wine_id", candidateIds)
      .neq("batch_id", batchId)
      .not("lwin_id", "is", null)
      .gte("lwin_score", LWIN_APPLY_MIN_SCORE)
      .range(from, to),
  );

  const otherBatchIds = Array.from(new Set(otherRows.map((row) => row.batch_id)));
  const liveBatchIds = new Set<string>();
  if (otherBatchIds.length > 0) {
    const { data: otherBatches, error: otherBatchesError } = await supabase
      .from("import_batches")
      .select("id, status")
      .in("id", otherBatchIds);
    if (otherBatchesError) throw otherBatchesError;
    for (const other of (otherBatches ?? []) as Array<{ id: string; status: string }>) {
      if (other.status !== "reverted") liveBatchIds.add(other.id);
    }
  }
  const justified = new Set<string>();
  for (const row of otherRows) {
    if (
      row.applied_wine_id &&
      liveBatchIds.has(row.batch_id) &&
      row.lwin_id === stamps.get(row.applied_wine_id)?.lwinId
    ) {
      justified.add(row.applied_wine_id);
    }
  }

  let cleared = 0;
  for (const wine of clearCandidates) {
    if (justified.has(wine.id)) continue;
    const stamp = stamps.get(wine.id);
    if (!stamp) continue;
    // Guard 4: re-check the EXACT pair server-side — a concurrent
    // higher-score write between our read and this UPDATE makes the
    // match fail and the stamp survives untouched.
    const { data: updated, error: updateError } = await supabase
      .from("wines")
      .update({ lwin_id: null, lwin_match_score: null })
      .eq("id", wine.id)
      .eq("restaurant_id", restaurantId)
      .eq("lwin_id", stamp.lwinId)
      .eq("lwin_match_score", stamp.score)
      .select("id");
    if (updateError) throw updateError;
    cleared += (updated ?? []).length;
  }
  return cleared;
}
