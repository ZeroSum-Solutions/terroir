import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { LedgerFailure, undoBatch } from "@/lib/reconcile-ledger";

export const runtime = "nodejs";

const UndoSchema = z.strictObject({ batch_id: z.string().uuid() });

function failure(error: LedgerFailure) {
  if (error.kind === "not_found") return Errors.notFound("Reconcile batch");
  if (error.kind === "conflict") {
    return apiError(409, "reconcile_conflict", error.message, error.details);
  }
  return apiError(500, "internal_error", "Reconcile undo failed.", error.details);
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const parsed = await parseJson(request, UndoSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const batch = await undoBatch(
        auth.supabase,
        auth.restaurantId,
        auth.user.id,
        parsed.data.batch_id,
      );
      return NextResponse.json({ batch });
    } catch (error) {
      if (error instanceof LedgerFailure) return failure(error);
      throw error;
    }
  });
}
