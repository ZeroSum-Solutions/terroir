import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { fetchDrinkWindowAlerts } from "@/lib/drink-window/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-039 — GET /api/insights/drink-window-alerts
 *
 * Returns the list of wines that should appear as alerts in the
 * Insights Monday briefing. The pipeline lives in
 * @/lib/drink-window/alerts so it can't drift from the server-component
 * direct call in insights/page.tsx (code-quality-review finding 5).
 */
export async function GET() {
  return withApiHandler(getDrinkWindowAlerts);
}

async function getDrinkWindowAlerts() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  try {
    const alerts = await fetchDrinkWindowAlerts(supabase, restaurantId);
    return NextResponse.json({ alerts });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "insights-drink-alerts", phase: "fetch" },
      extra: { restaurantId },
    });
    return Errors.internal("Failed to fetch alerts.");
  }
}
