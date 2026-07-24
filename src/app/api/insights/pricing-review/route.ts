import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { fetchPricingAlerts } from "@/lib/pricing/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-040 — GET /api/insights/pricing-review
 *
 * Returns the list of wines flagged for pricing review (outliers from
 * user-set targets, after snooze + 86'd filters). Pipeline lives in
 * @/lib/pricing/alerts so it can't drift from the server-component
 * direct call in insights/page.tsx (architect finding 7).
 */
export async function GET() {
  return withApiHandler(getPricingReview);
}

async function getPricingReview() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  try {
    const alerts = await fetchPricingAlerts(supabase, restaurantId);
    return NextResponse.json({ alerts });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "insights-pricing-review", phase: "fetch" },
      extra: { restaurantId },
    });
    return Errors.internal("Failed to fetch pricing alerts.");
  }
}
