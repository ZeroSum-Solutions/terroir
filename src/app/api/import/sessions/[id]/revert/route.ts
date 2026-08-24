/**
 * POST /api/import/sessions/[id]/revert — revert every batch in a session
 * as a unit (P3 §3.4), reverse chunk order, per-batch exception isolation.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { Errors } from "@/lib/api/errors";
import { parseParams } from "@/lib/api/validation";
import { SessionIdParamsSchema } from "@/domains/import/request-schemas";
import { revertImportSession } from "@/domains/import/session-service";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = Promise<{ id: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => postRevert(params));
}

async function postRevert(params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const parsedParams = await parseParams(params, SessionIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const result = await revertImportSession(supabase, id);
  if (!result.ok) {
    if (result.error.code === "not_found") return Errors.notFound("Import session");
    throw new Error(result.error.message);
  }

  return NextResponse.json({ sessionId: result.sessionId, batches: result.batches });
}
