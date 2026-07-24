import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  closeOpenBottle,
  PourAlreadyClosedError,
  PourForbiddenError,
  PourNotFoundError,
  PourRpcError,
} from "@/domains/pours/pour-service";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

const ParamsSchema = z.strictObject({ id: z.string().uuid() });

/**
 * POST /api/open-bottles/[id]/close
 *
 * BND-122 / ARCH-038. Closes an open bottle via record_pour RPC.
 * Calls record_pour with kind=spill and ml=remaining_ml, which drains
 * the bottle and triggers closed_at=now() via the DB trigger.
 * Direct INSERT/UPDATE on pour_events and open_bottles is blocked by RLS.
 *
 * Auth: any member (staff+) can close bottles.
 *
 * 200: { closed: { id, wine_id, closed_at } }
 * 400: invalid bottle id
 * 401: unauthenticated
 * 403: bottle not in caller's restaurant
 * 404: bottle not found
 * 409: already closed
 * 500: unhandled failure
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(() => postCloseBottle(params));
}

async function postCloseBottle(params: Promise<{ id: string }>) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;
  const parsed = await parseParams(params, ParamsSchema);
  if (!parsed.ok) return parsed.response;
  const { id } = parsed.data;

  try {
    const closed = await closeOpenBottle({
      supabase,
      restaurantId,
      bottleId: id,
    });
    return NextResponse.json({ closed });
  } catch (error) {
    if (error instanceof PourNotFoundError) {
      return Errors.notFound("Bottle");
    }
    if (error instanceof PourForbiddenError) {
      return Errors.forbidden("Forbidden.");
    }
    if (error instanceof PourAlreadyClosedError) {
      return Errors.conflict("already_closed", "Bottle is already closed.");
    }
    if (error instanceof PourRpcError) {
      return Errors.internal("Failed to close bottle.");
    }
    throw error;
  }
}
