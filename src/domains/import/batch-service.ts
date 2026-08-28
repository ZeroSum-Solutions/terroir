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
 * adds. After the RPC succeeds, best-effort clean up wines/stamps that
 * are provably attributable to this specific revert (see
 * cleanupOrphanWines / clearBatchLwinStamps below). Cleanup failure must
 * never fail the revert — the revert already succeeded — so both steps
 * are caught and logged, never rethrown.
 *
 * CRITICAL ORDERING (Sol audit 2026-08-27, round 2): the snapshot read
 * below MUST happen BEFORE the revert_import_batch RPC call, not after.
 * revert_import_batch (0109) itself sets `updated_at = now()` on every
 * row it reverts — reading the snapshot afterward would destroy the exact
 * apply-time evidence cleanupOrphanWines/clearBatchLwinStamps depend on. */
export async function revertImportBatch(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
): Promise<RevertBatchResult> {
  const snapshotRows = await fetchAllRows<AppliedRowSnapshot>((from, to) =>
    supabase
      .from("import_batch_rows")
      .select("id, applied_wine_id, updated_at, lwin_id, lwin_score")
      .eq("batch_id", batchId)
      .eq("restaurant_id", restaurantId)
      .eq("apply_status", "applied")
      .order("id", { ascending: true })
      .range(from, to),
  );

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
    const result = await cleanupOrphanWines(supabase, restaurantId, batchId, snapshotRows);
    orphanWinesDeleted = result.deleted;
    if (result.failures > 0) {
      console.error(
        `revertImportBatch: cleanupOrphanWines skipped ${result.failures} candidate(s) after a per-wine error for batch ${batchId}; ${result.deleted} confirmed delete(s) still counted`,
      );
    }
  } catch (cleanupError) {
    console.error(`revertImportBatch: orphan wine cleanup failed for batch ${batchId}`, cleanupError);
  }

  let lwinStampsCleared = 0;
  try {
    const result = await clearBatchLwinStamps(supabase, restaurantId, batchId, snapshotRows);
    lwinStampsCleared = result.cleared;
    if (result.failures > 0) {
      console.error(
        `revertImportBatch: clearBatchLwinStamps skipped ${result.failures} candidate(s) after a per-wine error for batch ${batchId}; ${result.cleared} confirmed clear(s) still counted`,
      );
    }
  } catch (unstampError) {
    console.error(`revertImportBatch: lwin unstamp failed for batch ${batchId}`, unstampError);
  }

  return { ok: true, revertedCount: (data as number | null) ?? 0, orphanWinesDeleted, lwinStampsCleared };
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
 * differs per table) — this helper only owns the paging loop. */
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

/** Every table/row in WINE_REFERENCING_TABLES, plus any OTHER (non-
 * reverting) batch's own import_batch_rows.applied_wine_id claims, that
 * still names one of `wineIds`. Shared by cleanupOrphanWines' bulk sweep
 * and its fresh single-wine re-check immediately before each DELETE. */
async function findReferencedWineIds(
  supabase: SupabaseClient<Database>,
  wineIds: string[],
  excludeBatchId: string,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (wineIds.length === 0) return referenced;

  for (const table of WINE_REFERENCING_TABLES) {
    const refs = await fetchAllRows<{ wine_id: string }>((from, to) =>
      supabase
        .from(table)
        .select("wine_id")
        .in("wine_id", wineIds)
        .order("wine_id", { ascending: true })
        .range(from, to),
    );
    for (const row of refs) referenced.add(row.wine_id);
  }

  const otherBatchRows = await fetchAllRows<{ applied_wine_id: string | null }>((from, to) =>
    supabase
      .from("import_batch_rows")
      .select("applied_wine_id")
      .in("applied_wine_id", wineIds)
      .neq("batch_id", excludeBatchId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  for (const row of otherBatchRows) {
    if (row.applied_wine_id) referenced.add(row.applied_wine_id);
  }

  return referenced;
}

/** Deletes wines this batch's apply step PROVABLY created, and ONLY
 * those. Redesigned in the Sol audit 2026-08-27 round-2 pass: round 1's
 * `wines.created_at >= batch.created_at` guard was justified by the FALSE
 * claim that every product write path creating a wine also creates a
 * referencing row in the same operation — real bare-wine paths exist
 * (src/app/api/cellar/route.ts, .../inventory/save-scan/route.ts, .../
 * wines/create-from-lwin/route.ts, the last of which never gets a
 * reference until a later, separate user action). This version proves
 * authorship instead of guessing a window.
 *
 * A wine qualifies for deletion only when ALL of these hold:
 *   1. some row in `snapshotRows` (this batch's applied rows, read BEFORE
 *      the revert RPC ran — see revertImportBatch's header) names it as
 *      applied_wine_id, AND that row's own `updated_at` EXACTLY equals
 *      the wine's `created_at`. apply_import_batch_chunk (0108) inserts a
 *      wine with created_at default now(), then updates that SAME row's
 *      updated_at = now() in the SAME transaction/call — one now() either
 *      way — so this equality is provable authorship, not a heuristic
 *      window. The one accepted residual: two DIFFERENT apply-chunk
 *      transactions landing on the exact same microsecond timestamp —
 *      negligible, named here rather than silently assumed away;
 *   2. it has zero references across every other wines(id)-referencing
 *      table (WINE_REFERENCING_TABLES) AND zero references from another
 *      batch's import_batch_rows.applied_wine_id, checked once in bulk
 *      and then RE-CHECKED, single-wine, immediately before that wine's
 *      own DELETE — closing most of the window between the bulk sweep
 *      and the delete itself. The residual that remains even with the
 *      re-check (Sol round-1 finding 3, re-confirmed round 2 finding 2):
 *      stock_adjustments (src/app/api/stock-adjustments/route.ts) and
 *      availability_events (src/app/api/wines/[id]/availability/route.ts)
 *      writers do NOT require live inventory — either can insert a
 *      fresh, ON DELETE CASCADE-linked row in the seconds-wide gap
 *      between this re-check and the DELETE statement actually
 *      committing, and that row would be destroyed by the cascade.
 *      inventory_items is ON DELETE RESTRICT, so a concurrent inventory
 *      insert in that same window makes the DELETE fail outright instead
 *      — caught per-wine (see below) and simply skipped, never silently
 *      pretended to have succeeded;
 *   3. it belongs to the reverting restaurant (explicit filter, matching
 *      this file's belt-and-suspenders pattern — never rely on RLS
 *      alone).
 *
 * Per-wine delete errors are caught individually (Sol round-2 finding 7)
 * so one bad delete never discards the count already earned by wines
 * deleted earlier in the same call; `failures` is for logging only. */
async function cleanupOrphanWines(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
  snapshotRows: AppliedRowSnapshot[],
): Promise<{ deleted: number; failures: number }> {
  const rowTimestampsByWine = new Map<string, Set<string>>();
  for (const row of snapshotRows) {
    if (!row.applied_wine_id) continue;
    const timestamps = rowTimestampsByWine.get(row.applied_wine_id) ?? new Set<string>();
    timestamps.add(row.updated_at);
    rowTimestampsByWine.set(row.applied_wine_id, timestamps);
  }
  const candidateWineIds = Array.from(rowTimestampsByWine.keys());
  if (candidateWineIds.length === 0) return { deleted: 0, failures: 0 };

  const wines = await fetchAllRows<{ id: string; created_at: string }>((from, to) =>
    supabase
      .from("wines")
      .select("id, created_at")
      .in("id", candidateWineIds)
      .eq("restaurant_id", restaurantId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  // Guard 1: provable authorship — the wine's created_at exactly matches
  // one of THIS wine's own snapshot rows' updated_at (same apply-chunk
  // transaction).
  const batchCreatedWineIds = wines
    .filter((wine) => rowTimestampsByWine.get(wine.id)?.has(wine.created_at))
    .map((wine) => wine.id);
  if (batchCreatedWineIds.length === 0) return { deleted: 0, failures: 0 };

  // Guard 2 (bulk pass).
  const referenced = await findReferencedWineIds(supabase, batchCreatedWineIds, batchId);
  const orphanCandidates = batchCreatedWineIds.filter((id) => !referenced.has(id));

  let deleted = 0;
  let failures = 0;
  for (const wineId of orphanCandidates) {
    try {
      // Guard 2 (fresh, single-wine re-check immediately before delete).
      const stillReferenced = await findReferencedWineIds(supabase, [wineId], batchId);
      if (stillReferenced.has(wineId)) continue;

      const { data: deletedRows, error: deleteError } = await supabase
        .from("wines")
        .delete()
        .eq("id", wineId)
        .eq("restaurant_id", restaurantId)
        .select("id");
      if (deleteError) throw deleteError;
      deleted += (deletedRows ?? []).length;
    } catch (err) {
      failures += 1;
      console.error(`cleanupOrphanWines: delete failed for wine ${wineId} (batch ${batchId})`, err);
    }
  }
  return { deleted, failures };
}

/** Clears wines.lwin_id/lwin_match_score stamps THIS batch's apply
 * wrote, for wines that survive revert (a deleted wine needs no unstamp
 * — cleanupOrphanWines always runs first, see revertImportBatch).
 *
 * Redesigned in the Sol audit 2026-08-27 round-2 pass: round 1's
 * authorship proof — "a non-null lwin_match_score is only ever written
 * by a batch apply" (finding 4 of round 1) — is FALSE. wines RLS grants
 * members unrestricted UPDATE (supabase/schema.snapshot.sql, "members
 * can update their wines"), so any client can pre-write an identical
 * (lwin_id, lwin_match_score) pair, defeating an exact-pair-only check
 * (round 2 finding 3). Fix: add a TIMESTAMP proof ALONGSIDE the exact-pair
 * check, not instead of it — either alone is unsafe (see below); together
 * they close the round-1 hole.
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
 *      (0108), so this equality proves this row's own apply-chunk call
 *      was the LAST write to this wine's row — closing the round-1 hole
 *      for a pre-write or overwrite happening AFTER apply and BEFORE
 *      this revert call (the concrete exploit the finding describes):
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
 *      one it actually wrote. Requiring the current value to match this
 *      row's own value proves apply's CASE genuinely resolved to this
 *      row, not the pre-existing one.
 * Together, both checks are still not airtight: a third party writing the
 * EXACT (lwin_id, lwin_match_score) pair this row's own LWIN match would
 * independently compute, BEFORE apply ran, on a wine this row also
 * dedup-matches, passes both checks by coincidence. That requires
 * guessing a specific trigram-similarity float to exact precision ahead
 * of time — accepted as negligible, the same order of residual as
 * cleanupOrphanWines' own named microsecond-timestamp-collision residual.
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
 * justification lookup added nothing the timestamp proof doesn't already
 * give for free, so it is dropped along with the unpaged status query it
 * required.
 *
 * Per-wine errors are caught individually so one failing UPDATE never
 * discards counts already earned earlier in the same call (Sol round-2
 * finding 7), same contract as cleanupOrphanWines. */
async function clearBatchLwinStamps(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  batchId: string,
  snapshotRows: AppliedRowSnapshot[],
): Promise<{ cleared: number; failures: number }> {
  const qualifyingRows = snapshotRows.filter(
    (row): row is AppliedRowSnapshot & { applied_wine_id: string; lwin_id: string; lwin_score: number } =>
      row.applied_wine_id !== null &&
      row.lwin_id !== null &&
      row.lwin_score !== null &&
      row.lwin_score >= LWIN_APPLY_MIN_SCORE,
  );
  if (qualifyingRows.length === 0) return { cleared: 0, failures: 0 };

  const rowsByWine = new Map<string, typeof qualifyingRows>();
  for (const row of qualifyingRows) {
    const rows = rowsByWine.get(row.applied_wine_id) ?? [];
    rows.push(row);
    rowsByWine.set(row.applied_wine_id, rows);
  }
  const wineIds = Array.from(rowsByWine.keys());

  const wines = await fetchAllRows<{
    id: string;
    lwin_id: string | null;
    lwin_match_score: number | null;
    updated_at: string;
  }>((from, to) =>
    supabase
      .from("wines")
      .select("id, lwin_id, lwin_match_score, updated_at")
      .in("id", wineIds)
      .eq("restaurant_id", restaurantId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  let cleared = 0;
  let failures = 0;
  for (const wine of wines) {
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
  return { cleared, failures };
}
