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

/**
 * One message for BOTH sibling-conflict paths — the pre-flight guard below and
 * the database barrier's P0004. They describe the same situation to the
 * operator and must never drift into two different explanations of one refusal.
 */
const SIBLING_ALREADY_APPLIED_MESSAGE =
  "Another live import batch for this same file already has applied rows. Revert the duplicate under " +
  "Recent imports before applying this one.";

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
    .select("id, content_sha256, status")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return Errors.notFound("Import batch");
  const { content_sha256: contentSha256, status: preflightStatus } = batch as {
    id: string;
    content_sha256: string | null;
    status: string | null;
  };

  // Pre-flight guard. This is NOT the enforcement point — migration 0128 put
  // that inside apply_import_batch_chunk itself (advisory lock + under-lock
  // recheck, raising P0004), which is the only place it can be atomic. This
  // read-only check survives for two reasons:
  //
  //   1. DEPLOYMENT ORDER. Migrations reach production out-of-band, not from
  //      CI, so a build carrying this route can be live before 0128 is applied.
  //      Deleting the guard on that assumption would leave production with NO
  //      protection at all in the window between the two. Remove it only once
  //      0128 is confirmed applied in production — see the "cross-batch apply
  //      race" section of docs/runbooks/csv-import.md.
  //   2. It refuses earlier and more cheaply than letting the RPC raise.
  //
  // On its own it is only a TOCTOU narrowing — it and applyImportBatchChunk
  // below are separate awaits over separate transactions, and the RPC is
  // granted directly to `authenticated`, so a direct RPC call skips it
  // entirely. Being read-only, it can only ever REFUSE an apply, never destroy
  // a concurrent writer's data.
  // A reverted batch is a no-op in the RPC: 0128 returns before it ever reaches
  // the barrier. Running the guard here anyway made the two layers disagree —
  // the route answered 409 sibling_already_applied for a batch the barrier
  // would have accepted (as a no-op) — so the guard mirrors that early return.
  if (preflightStatus !== "reverted") {
    const conflict = await findSiblingWithAppliedRows(supabase, restaurantId, id, contentSha256);
    // Deliberate, documented divergence: the barrier has no lookup step and so
    // has no equivalent failure, while this pre-flight can fail to read. It
    // fails CLOSED, because its entire reason to exist is the window before
    // 0128 is applied in production, when refusing is the only protection
    // available. It is therefore strictly more conservative than the barrier,
    // never less — and it disappears with the guard once 0128 is confirmed live.
    if (!conflict.ok) return apiError(409, conflict.error.code, conflict.error.message);
    if (conflict.conflictBatchId) {
      return apiError(409, "sibling_already_applied", SIBLING_ALREADY_APPLIED_MESSAGE);
    }
  }

  let result;
  try {
    result = await applyImportBatchChunk(supabase, id);
  } catch (error) {
    // P0004 — 0128's barrier refused this apply because a sibling batch for the
    // same underlying file already has applied rows. Unlike the guard above
    // this is authoritative: it was evaluated under the advisory lock, inside
    // the same transaction that would have written the rows. Same 409 body, so
    // the client cannot tell (or need to tell) which layer refused.
    const pgError = error as { code?: string } | null;
    if (pgError?.code === "P0004") {
      return apiError(409, "sibling_already_applied", SIBLING_ALREADY_APPLIED_MESSAGE);
    }
    throw error;
  }

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
