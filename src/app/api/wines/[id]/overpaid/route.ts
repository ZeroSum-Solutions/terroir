import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * BND-139 — POST /api/wines/[id]/overpaid
 *
 * Toggle the overpaid_flag on a wine for follow-up.
 * Any member can flag/unflag.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { id } = await ctx.params;
  if (!id) {
    return Errors.badRequest("wine id required");
  }

  // Read current state with tenant-scope check
  const { data: wine, error: fetchErr } = await supabase
    .from("wines")
    .select("id, overpaid_flag")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: { surface: "wines-overpaid", phase: "fetch" },
      extra: { wineId: id, restaurantId },
    });
    return Errors.internal("Lookup failed.");
  }
  if (!wine) {
    return Errors.notFound("Wine");
  }

  // Toggle the flag
  const newValue = !wine.overpaid_flag;
  const { error: updateErr } = await supabase
    .from("wines")
    .update({ overpaid_flag: newValue })
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (updateErr) {
    Sentry.captureException(updateErr, {
      tags: { surface: "wines-overpaid", phase: "update" },
      extra: { wineId: id, restaurantId },
    });
    return Errors.internal("Failed to update flag.");
  }

  return NextResponse.json({ wineId: id, overpaid_flag: newValue });
}