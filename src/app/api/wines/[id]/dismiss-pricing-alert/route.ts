import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * BND-040 — POST /api/wines/[id]/dismiss-pricing-alert
 *
 * Dismiss the pricing-review alert for a wine. Default 30 days, mirrors
 * BND-039 snooze pattern.
 *
 * Auth: owner+manager only.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    return Errors.forbidden("Dismissing pricing alerts requires owner or manager role.");
  }

  const { id } = await ctx.params;
  if (!id) {
    return Errors.badRequest("wine id required");
  }

  // Optional body: { days: number }. Default 30, max 365.
  // Audit-finding M2: days=0 is the unsnooze signal — clears
  // pricing_dismissed_until so the alert reappears immediately.
  let days = 30;
  let unsnooze = false;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.days === "number" && Number.isFinite(body.days)) {
      if (body.days === 0) {
        unsnooze = true;
      } else {
        days = Math.max(1, Math.min(365, Math.round(body.days)));
      }
    }
  } catch {
    // No body / non-JSON → default. Not an error.
  }

  // Tenant-scope check (defense-in-depth alongside RLS).
  const { data: wine, error: fetchErr } = await supabase
    .from("wines")
    .select("id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: { surface: "wines-dismiss-pricing", phase: "wine-fetch" },
      extra: { wineId: id, restaurantId },
    });
    return Errors.internal("Lookup failed.");
  }
  if (!wine) {
    return Errors.notFound("Wine");
  }

  // Unsnooze path — direct UPDATE to NULL.
  if (unsnooze) {
    const { error: clearErr } = await supabase
      .from("wines")
      .update({ pricing_dismissed_until: null })
      .eq("id", id)
      .eq("restaurant_id", restaurantId);
    if (clearErr) {
      Sentry.captureException(clearErr, {
        tags: { surface: "wines-dismiss-pricing", phase: "clear" },
        extra: { wineId: id, restaurantId },
      });
      return Errors.internal("Failed to clear dismissal.");
    }
    return NextResponse.json({ wineId: id, dismissedUntil: null, days: 0 });
  }

  const { data: until, error: rpcError } = await supabase.rpc(
    "dismiss_pricing_alert",
    { p_wine_id: id, p_days: days },
  );

  if (rpcError) {
    Sentry.captureException(rpcError, {
      tags: { surface: "wines-dismiss-pricing", phase: "rpc" },
      extra: { wineId: id, restaurantId, days },
    });
    return Errors.internal("Failed to dismiss alert.");
  }

  return NextResponse.json({
    wineId: id,
    dismissedUntil: until,
    days,
  });
}
