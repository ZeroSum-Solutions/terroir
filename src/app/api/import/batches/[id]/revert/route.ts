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

export const runtime = "nodejs";
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

  const result = await revertImportBatch(supabase, restaurantId, id);
  if (!result.ok) {
    if (result.error.code === "not_found") return Errors.notFound("Import batch");
    return apiError(409, result.error.code, result.error.message);
  }

  return NextResponse.json({
    revertedCount: result.revertedCount,
    orphanWinesDeleted: result.orphanWinesDeleted,
    lwinStampsCleared: result.lwinStampsCleared,
  });
}
