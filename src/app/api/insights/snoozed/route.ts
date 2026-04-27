import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-040 follow-up — GET /api/insights/snoozed
 *
 * Returns the list of wines with active snoozes (drink-window alert OR
 * pricing alert OR both). Powers the SnoozedAlertsCard on Insights —
 * lets operators see what's been snoozed and unsnooze early.
 *
 * "Active snooze" = the column is non-null AND in the future.
 * Past timestamps mean the snooze already expired; the alert reappears
 * naturally without needing a list entry.
 *
 * Per row, returns which kind of snooze applies and when it expires.
 * A wine could have both kinds active at once (separate fields).
 */

export type SnoozedRow = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  // Drink-window snooze — null when not snoozed.
  drinkWindowSnoozedUntil: string | null;
  // Pricing review snooze — null when not snoozed.
  pricingDismissedUntil: string | null;
};

export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const nowIso = new Date().toISOString();

  try {
    // Pull wines that have at least one active snooze. Filter at SQL
    // layer (efficient) by combining the two columns via .or().
    const { data: wines, error } = await supabase
      .from("wines")
      .select(
        "id, name, producer, vintage, alert_snoozed_until, pricing_dismissed_until",
      )
      .eq("restaurant_id", restaurantId)
      .or(
        `alert_snoozed_until.gt.${nowIso},pricing_dismissed_until.gt.${nowIso}`,
      );
    if (error) throw error;

    // Filter to active-only (defense — the .or() above should already
    // filter, but the SQL semantics are subtle around NULL).
    const rows: SnoozedRow[] = (wines ?? [])
      .map((w) => {
        const dw = w.alert_snoozed_until;
        const pr = w.pricing_dismissed_until;
        const dwActive = dw && new Date(dw).getTime() > Date.now();
        const prActive = pr && new Date(pr).getTime() > Date.now();
        if (!dwActive && !prActive) return null;
        return {
          wine_id: w.id,
          name: w.name,
          producer: w.producer,
          vintage: w.vintage,
          drinkWindowSnoozedUntil: dwActive ? dw : null,
          pricingDismissedUntil: prActive ? pr : null,
        };
      })
      .filter((r): r is SnoozedRow => r !== null);

    // Sort: soonest-expiring first, then alphabetical.
    rows.sort((a, b) => {
      const aSoon = Math.min(
        a.drinkWindowSnoozedUntil
          ? new Date(a.drinkWindowSnoozedUntil).getTime()
          : Infinity,
        a.pricingDismissedUntil
          ? new Date(a.pricingDismissedUntil).getTime()
          : Infinity,
      );
      const bSoon = Math.min(
        b.drinkWindowSnoozedUntil
          ? new Date(b.drinkWindowSnoozedUntil).getTime()
          : Infinity,
        b.pricingDismissedUntil
          ? new Date(b.pricingDismissedUntil).getTime()
          : Infinity,
      );
      if (aSoon !== bSoon) return aSoon - bSoon;
      return a.producer.localeCompare(b.producer);
    });

    return NextResponse.json({ snoozed: rows });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "insights-snoozed", phase: "fetch" },
      extra: { restaurantId },
    });
    return NextResponse.json(
      { error: "Failed to fetch snoozed alerts." },
      { status: 500 },
    );
  }
}
