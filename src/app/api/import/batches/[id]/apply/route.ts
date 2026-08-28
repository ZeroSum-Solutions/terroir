/**
 * POST /api/import/batches/[id]/apply — apply the next chunk of eligible
 * rows. Bounded to APPLY_CHUNK_SIZE rows per call so this endpoint stays
 * well inside a normal request's time budget regardless of total file
 * size — the client calls it repeatedly until `done` comes back true.
 * Safe to retry after a timeout/crash/navigation: already-applied rows
 * are never revisited (see apply_import_batch_chunk, 0076).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { Errors, apiError } from "@/lib/api/errors";
import { parseParams } from "@/lib/api/validation";
import { BatchIdParamsSchema } from "@/domains/import/request-schemas";
import { applyImportBatchChunk, findSiblingWithAppliedRows } from "@/domains/import/batch-service";

export const runtime = "nodejs";
export const maxDuration = 30;

type Params = Promise<{ id: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => postApply(params));
}

async function postApply(params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsedParams = await parseParams(params, BatchIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, content_sha256")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return Errors.notFound("Import batch");
  const contentSha256 = (batch as { id: string; content_sha256: string | null }).content_sha256;

  // Round-10 audit, HONESTY-CORRECTED round-11: apply-time guard, NOT
  // enforcement — reconciliation (reconcileLiveBatchesForFile,
  // batch-service.ts) no longer has any authority to revert a rival, so
  // this read-only check runs HERE, immediately before this chunk is
  // allowed to apply, as the best available narrowing of the "at most one
  // applied batch per underlying file" invariant. It is NOT a closure of
  // that invariant: this guard and applyImportBatchChunk below are
  // separate awaits over separate transactions, so two concurrent applies
  // to sibling batches can both pass this check and both persist
  // inventory — see findSiblingWithAppliedRows' own comment for the full
  // proof and for why closing it needs a migration (locked for this
  // change). What this DOES guarantee, because it is read-only: it can
  // only ever REFUSE an apply, never destroy a concurrent writer's data,
  // unlike the revert-based enforcement it replaces.
  const conflict = await findSiblingWithAppliedRows(supabase, restaurantId, id, contentSha256);
  if (!conflict.ok) return apiError(409, conflict.error.code, conflict.error.message);
  if (conflict.conflictBatchId) {
    return apiError(
      409,
      "sibling_already_applied",
      "Another live import batch for this same file already has applied rows. Revert the duplicate under " +
        "Recent imports before applying this one.",
    );
  }

  const result = await applyImportBatchChunk(supabase, id);

  // WARN 4 (round-9/10 audit): the batch's ACTUAL current status is now
  // read AFTER the apply attempt, not before — a revert landing mid-call
  // (e.g. the operator's own manual "Revert this import" click racing this
  // request) must be visible on THIS response so both drivers stop on the
  // very next check, not one extra round trip later. (ApplyChunkResult's
  // own `status` is a DIFFERENT thing — recomputeBatchStatus derives it
  // purely from row counts and can never report "reverted": its own update
  // is `.neq("status","reverted")`, so once a batch is reverted that
  // derived status just keeps reporting a stale pseudo-status forever.)
  const { data: postApplyBatch, error: postApplyError } = await supabase
    .from("import_batches")
    .select("status")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (postApplyError) throw postApplyError;
  const batchStatus = (postApplyBatch as { status: string } | null)?.status ?? result.status;

  return NextResponse.json({
    processed: result.processed,
    status: result.status,
    // The real batch status (see above) — distinct from `status`, which is
    // only ever "created" | "applying" | "completed". Both apply drivers
    // stop on this being "reverted".
    batchStatus,
    counts: result.counts,
    // "Nothing left for apply to do right now" — distinct from
    // status === "completed", which additionally requires zero rows
    // still pending operator resolution. A client should stop calling
    // apply once `done` is true either way (calling again would just
    // process zero rows until the operator resolves more). Also true once
    // the batch itself is reverted — see batchStatus's own comment above.
    done: batchStatus === "reverted" || result.counts.eligibleNotApplied === 0,
  });
}
