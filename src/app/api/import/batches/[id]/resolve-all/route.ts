/**
 * POST /api/import/batches/[id]/resolve-all — bulk operator resolution
 * for a batch's whole pending bucket: `include` (cost-present rows only —
 * missing-cost rows keep requiring the per-row path with an explicit
 * manual cost) or `exclude` (every pending row). Exists for bulk
 * onboarding: a large chunked import of wines outside the LWIN catalog
 * lands 100% pending, and per-row taps do not scale to thousands of rows.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { apiError } from "@/lib/api/errors";
import { parseJson, parseParams } from "@/lib/api/validation";
import { BatchIdParamsSchema, BulkResolveBodySchema } from "@/domains/import/request-schemas";
import { bulkResolveImportBatchRows } from "@/domains/import/batch-service";

export const runtime = "nodejs";
export const maxDuration = 30;

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => postResolveAll(request, params));
}

async function postResolveAll(request: NextRequest, params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, user } = auth;

  const parsedParams = await parseParams(params, BatchIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;

  const parsedBody = await parseJson(request, BulkResolveBodySchema);
  if (!parsedBody.ok) return parsedBody.response;

  const result = await bulkResolveImportBatchRows(
    supabase,
    restaurantId,
    user.id,
    parsedParams.data.id,
    parsedBody.data.action,
  );
  if (!result.ok) {
    const status = result.error.code === "not_found" ? 404 : 422;
    return apiError(status, result.error.code, result.error.message);
  }

  return NextResponse.json({
    resolved: result.resolved,
    remainingPending: result.remainingPending,
  });
}
