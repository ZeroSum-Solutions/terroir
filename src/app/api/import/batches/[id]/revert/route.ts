/**
 * POST /api/import/batches/[id]/revert — undo a completed import batch
 * as a unit. Deletes exactly the inventory rows this batch created
 * (see revert_import_batch, 0076) — never touches pre-existing
 * inventory, even for the same wines.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { Errors, apiError } from "@/lib/api/errors";
import { parseParams } from "@/lib/api/validation";
import { BatchIdParamsSchema } from "@/domains/import/request-schemas";
import { revertImportBatch } from "@/domains/import/batch-service";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const runtime = "nodejs";
// Vercel/Next.js serverless metadata; inert on Railway (railway.toml runs
// this app as a plain long-running `pnpm start` process, not a per-
// invocation serverless function with its own timeout). Kept for
// portability, not relied on as a real ceiling — see
// CLEANUP_BUDGET_FROM_ENTRY_MS's own comment (src/domains/import/
// constants.ts) for what actually bounds this route's cleanup phase.
export const maxDuration = 30;

type Params = Promise<{ id: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => postRevert(params));
}

async function postRevert(params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsedParams = await parseParams(params, BatchIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return Errors.notFound("Import batch");

  // Sol audit 2026-08-27 round 3, finding 3: revertImportBatch's orphan-
  // wine reference checks (the bulk sweep + the fresh pre-delete
  // re-check) MUST run through a service-role client, never this route's
  // own RLS-scoped `supabase` — see revertImportBatch's own header for
  // the cross-tenant cascade-destruction mechanics this closes. A null
  // service client (misconfigured environment) is passed straight
  // through: revertImportBatch treats that as "skip orphan-wine cleanup
  // for this call," never as a reason to fail the revert itself.
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    console.error("revert route: service-role client unavailable; orphan-wine cleanup will be skipped for this revert");
  }

  const result = await revertImportBatch(supabase, restaurantId, id, serviceClient);
  if (!result.ok) {
    if (result.error.code === "not_found") return Errors.notFound("Import batch");
    return apiError(409, result.error.code, result.error.message);
  }

  return NextResponse.json({
    revertedCount: result.revertedCount,
    orphanWinesDeleted: result.orphanWinesDeleted,
    lwinStampsCleared: result.lwinStampsCleared,
    cleanupTruncated: result.cleanupTruncated,
    orphanCleanupSkipped: result.orphanCleanupSkipped,
    cleanupFailures: result.cleanupFailures,
  });
}
