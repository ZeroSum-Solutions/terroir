/**
 * POST /api/import/sessions — create a new multi-batch onboarding session
 * (P3 §3.1). A plain-file, non-chunked upload never needs this endpoint —
 * confirmImportBatch's sessionId/chunkIndex/chunkTotal fields are optional.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { CreateSessionBodySchema } from "@/domains/import/request-schemas";
import { createImportSession } from "@/domains/import/session-service";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  return withApiHandler(() => postSessions(request));
}

async function postSessions(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, user } = auth;

  const parsed = await parseJson(request, CreateSessionBodySchema, { allowEmpty: true });
  if (!parsed.ok) return parsed.response;

  const result = await createImportSession(supabase, restaurantId, user.id, {
    label: parsed.data.label,
    sourceSha256: parsed.data.sourceSha256,
    declaredChunkTotal: parsed.data.declaredChunkTotal,
  });

  return NextResponse.json({ sessionId: result.sessionId }, { status: 201 });
}
