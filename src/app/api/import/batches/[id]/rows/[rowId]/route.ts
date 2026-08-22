/**
 * PATCH /api/import/batches/[id]/rows/[rowId] — operator resolution for
 * a row sitting in the unmatched-LWIN / missing-cost bucket: `include`
 * (with a required manual unit cost if cost was missing) or `exclude`.
 * Never silently defaults a missing cost and never silently fuzzy-links
 * an unmatched row to a low-confidence LWIN guess — the operator's
 * choice is explicit and recorded (resolved_by/resolved_at).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { Errors, apiError } from "@/lib/api/errors";
import { parseJson, parseParams } from "@/lib/api/validation";
import { BatchRowParamsSchema, ResolveRowBodySchema } from "@/domains/import/request-schemas";
import { resolveImportBatchRow } from "@/domains/import/batch-service";

export const runtime = "nodejs";

type Params = Promise<{ id: string; rowId: string }>;

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => patchRow(request, params));
}

async function patchRow(request: NextRequest, params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, user } = auth;

  const parsedParams = await parseParams(params, BatchRowParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id: batchId, rowId } = parsedParams.data;

  const parsedBody = await parseJson(request, ResolveRowBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const { action, manualUnitCost } = parsedBody.data;

  // Defense-in-depth: confirm the row actually belongs to the batch id
  // in the URL (and, via restaurantId below, to this tenant) before
  // acting on it.
  const { data: row, error: rowError } = await supabase
    .from("import_batch_rows")
    .select("id")
    .eq("id", rowId)
    .eq("batch_id", batchId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (rowError) throw rowError;
  if (!row) return Errors.notFound("Import batch row");

  const result = await resolveImportBatchRow(supabase, restaurantId, user.id, rowId, action, manualUnitCost);
  if (!result.ok) {
    const status = result.error.code === "not_found" ? 404 : 422;
    return apiError(status, result.error.code, result.error.message);
  }

  return NextResponse.json({ ok: true });
}
