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
import { Errors } from "@/lib/api/errors";
import { parseParams } from "@/lib/api/validation";
import { BatchIdParamsSchema } from "@/domains/import/request-schemas";
import { applyImportBatchChunk } from "@/domains/import/batch-service";

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

  // Round-8 audit finding 3: `status` also selected here — the batch's
  // ACTUAL current status (unlike ApplyChunkResult.status below, which
  // recomputeBatchStatus derives purely from row counts and can never be
  // "reverted": its own update is `.neq("status","reverted")`, so once a
  // batch is reverted that derived status just keeps reporting a stale
  // pseudo-status forever). A batch reverted mid-apply (e.g. by
  // reconcileLiveBatchesForFile's own fail-closed cleanup) leaves its
  // not-yet-applied rows exactly as they were — apply_import_batch_chunk_v2
  // (0108) already no-ops on a reverted batch, but eligibleNotApplied never
  // drops to 0 on its own, so `done` derived from that count alone would
  // never flip true and a client would keep polling apply futilely.
  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, status")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return Errors.notFound("Import batch");
  const batchStatus = (batch as { id: string; status: string }).status;

  const result = await applyImportBatchChunk(supabase, id);

  return NextResponse.json({
    processed: result.processed,
    status: result.status,
    // Round-8 audit finding 3: the real batch status (see above) —
    // distinct from `status`, which is only ever "created" | "applying" |
    // "completed". Both apply drivers stop on this being "reverted".
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
