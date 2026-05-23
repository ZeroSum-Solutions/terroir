import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

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
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;
  const { id } = await params;

  // Fetch the bottle to verify it exists, is open, and belongs to this restaurant
  const { data: bottle, error: fetchError } = await supabase
    .from("open_bottles")
    .select("id, wine_id, remaining_ml, closed_at, restaurant_id")
    .eq("id", id)
    .single();

  if (fetchError || !bottle) {
    return Errors.notFound("Bottle not found.");
  }

  if (bottle.restaurant_id !== restaurantId) {
    return Errors.forbidden("Forbidden.");
  }

  if (bottle.closed_at) {
    return Errors.conflict("already_closed", "Bottle is already closed.");
  }

  const remainingMl = bottle.remaining_ml;
  const closedAt = new Date().toISOString();

  // ARCH-038: Use record_pour RPC (SECURITY DEFINER write path).
  // Direct INSERT/UPDATE on pour_events and open_bottles is blocked by RLS.
  // Calling with kind=spill and ml=remainingMl drains the bottle,
  // which triggers closed_at=now() via pour_events_maintain_open_bottle.
  const { error: pourError } = await supabase.rpc("record_pour", {
    p_wine_id: bottle.wine_id,
    p_ml: remainingMl,
    p_kind: "spill",
    p_note: "Bottle closed (discard remaining)",
  });

  if (pourError) {
    console.error("Failed to close bottle via record_pour:", pourError);
    Sentry.captureException(pourError, {
      tags: { surface: "open-bottles", phase: "close" },
      extra: { bottle_id: id, wine_id: bottle.wine_id },
    });
    return Errors.internal("Failed to close bottle.");
  }

  revalidatePath("/cellar/open");

  return NextResponse.json({
    closed: { id: bottle.id, wine_id: bottle.wine_id, closed_at: closedAt },
  });
}
