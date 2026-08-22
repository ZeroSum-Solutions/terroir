/**
 * GET /api/import/batches/[id] — one batch's status + full row detail
 * (validation errors, LWIN match status, resolution/apply state for
 * every row). Tenant-scoped: a batch id belonging to another
 * restaurant resolves to 404, never another tenant's data.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { Errors } from "@/lib/api/errors";
import { parseParams } from "@/lib/api/validation";
import { BatchIdParamsSchema } from "@/domains/import/request-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => getBatch(params));
}

async function getBatch(params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsedParams = await parseParams(params, BatchIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, filename, status, total_rows, created_at, reverted_at")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return Errors.notFound("Import batch");

  const { data: rows, error: rowsError } = await supabase
    .from("import_batch_rows")
    .select(
      "id, row_number, raw, row_state, validation_errors, lwin_status, lwin_id, lwin_score, cost_status, resolution, manual_unit_cost, apply_status, applied_inventory_item_id",
    )
    .eq("batch_id", id)
    .eq("restaurant_id", restaurantId)
    .order("row_number", { ascending: true });
  if (rowsError) throw rowsError;

  return NextResponse.json({ batch, rows: rows ?? [] });
}
