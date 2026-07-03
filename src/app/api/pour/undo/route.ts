import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  PourForbiddenError,
  PourNotFoundError,
  PourRpcError,
  undoLastPour,
} from "@/domains/pours/pour-service";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
});

/**
 * POST /api/pour/undo
 *
 * BND-119. Undoes the most recent pour or spill for a wine.
 * Calls undo_last_pour RPC (atomic: deletes latest pour_event,
 * restores open_bottles.remaining_ml, inserts availability_events row).
 * Role-gated inside the RPC to owner | manager | staff.
 *
 * 200: { open_bottle: { wine_id, remaining_ml, ... } }
 * 400: invalid body
 * 401: unauthenticated
 * 403: not a member
 * 404: no recent pour to undo
 * 500: any other RPC error
 */
export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid body.");
  }
  const { wine_id } = parsed.data;

  try {
    const openBottle = await undoLastPour({
      supabase,
      restaurantId,
      wineId: wine_id,
    });
    return NextResponse.json({ open_bottle: openBottle });
  } catch (error) {
    if (error instanceof PourNotFoundError) {
      return Errors.notFound("Pour to undo");
    }
    if (error instanceof PourForbiddenError) {
      return Errors.forbidden("Forbidden.");
    }
    if (error instanceof PourRpcError) {
      return Errors.internal("Undo failed.");
    }
    throw error;
  }
}
