/**
 * GET /api/import/sessions/[id] — aggregate progress across every child
 * batch of a multi-chunk onboarding session (P3 §3.3). RLS on
 * import_sessions/import_batches/import_batch_rows is the tenant boundary
 * — a foreign-tenant session id is simply invisible (getImportSessionProgress
 * returns null), reported here as 404, never leaking existence.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { Errors } from "@/lib/api/errors";
import { parseParams } from "@/lib/api/validation";
import { SessionIdParamsSchema } from "@/domains/import/request-schemas";
import { getImportSessionProgress } from "@/domains/import/session-service";

export const runtime = "nodejs";
export const maxDuration = 30;

type Params = Promise<{ id: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  return withApiHandler(() => getSession(params));
}

async function getSession(params: Params) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const parsedParams = await parseParams(params, SessionIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const progress = await getImportSessionProgress(supabase, id);
  if (!progress) return Errors.notFound("Import session");

  return NextResponse.json(progress);
}
