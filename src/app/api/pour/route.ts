import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  PourForbiddenError,
  PourNoInventoryError,
  PourNotFoundError,
  PourRpcError,
  recordPour,
} from "@/domains/pours/pour-service";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
  ml: z.number().int().positive().max(2000),
  kind: z.enum(["pour", "spill"]).default("pour"),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/pour
 *
 * BND-038. Records a pour (or spill) against the wine's open bottle.
 * Calls record_pour RPC (atomic: opens a new bottle if needed; handles
 * overage across bottles). Role-gated inside the RPC to
 * owner | manager | staff.
 *
 * 200: { open_bottle: { wine_id, remaining_ml, opened_at, ... } }
 * 400: invalid body
 * 401: unauthenticated (from requireMembership)
 * 403: caller not a member of this wine's restaurant (from RPC)
 * 404: target wine does not exist
 * 409: NO_INVENTORY — no sealed bottles to open (from RPC)
 * 500: any other RPC error (also reported to Sentry)
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postPour(request));
}

async function postPour(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id, ml, kind, note } = parsed.data;

  try {
    const openBottle = await recordPour({
      supabase,
      restaurantId,
      wineId: wine_id,
      ml,
      kind,
      note,
    });
    return NextResponse.json({ open_bottle: openBottle });
  } catch (error) {
    if (error instanceof PourNoInventoryError) {
      return Errors.conflict("no_inventory", "No inventory available.");
    }
    if (error instanceof PourNotFoundError) {
      return Errors.notFound("Wine");
    }
    if (error instanceof PourForbiddenError) {
      return Errors.forbidden("Forbidden.");
    }
    if (error instanceof PourRpcError) {
      return Errors.internal("Pour failed.");
    }
    throw error;
  }
}
