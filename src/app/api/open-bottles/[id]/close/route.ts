import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * POST /api/open-bottles/[id]/close
 *
 * BND-122. Closes an open bottle: sets closed_at and remaining_ml to 0,
 * and inserts a pour_event with kind='finish_bottle' for the audit trail.
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
  const { supabase, restaurantId, user } = auth;
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

  // Update the open bottle: set remaining to 0 and close it
  const { error: updateError } = await supabase
    .from("open_bottles")
    .update({ remaining_ml: 0, closed_at: closedAt })
    .eq("id", id);

  if (updateError) {
    console.error("Failed to close bottle:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "open-bottles", phase: "close" },
      extra: { bottle_id: id },
    });
    return Errors.internal("Failed to close bottle.");
  }

  // Insert audit event: finish_bottle with the discard delta
  const { error: eventError } = await supabase.from("pour_events").insert({
    wine_id: bottle.wine_id,
    restaurant_id: restaurantId,
    open_bottle_id: id,
    ml_delta: -remainingMl,
    kind: "finish_bottle",
    actor_user_id: user.id,
    note: "Bottle closed (discard remaining)",
    occurred_at: closedAt,
  });

  if (eventError) {
    console.error("Failed to record discard event:", eventError);
    Sentry.captureException(eventError, {
      tags: { surface: "open-bottles", phase: "close-event" },
      extra: { bottle_id: id, wine_id: bottle.wine_id },
    });
    // Non-fatal: bottle is already closed
  }

  revalidatePath("/cellar/open");

  return NextResponse.json({
    closed: { id: bottle.id, wine_id: bottle.wine_id, closed_at: closedAt },
  });
}
