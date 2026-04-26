import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { shouldTriggerAlert } from "@/lib/drink-window/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-039 — GET /api/insights/drink-window-alerts
 *
 * Returns the list of wines that should appear as alerts in the
 * Insights Monday briefing. Filters:
 *   • drink_window_end is non-null AND within the alert trigger window
 *     (≤ 1 year before close, or already past peak — see status.ts)
 *   • alert_snoozed_until is NULL OR in the past (snooze expired)
 *   • is_eightysixed = false (architect-review finding 4 — an 86'd wine
 *     with stock would otherwise alert; that's confusing)
 *   • bottle_count > 0 (no point alerting on wines we don't have)
 *
 * Returned shape powers the BriefingAlertCard component. Bottle count
 * comes from a join against inventory_items aggregated per wine.
 */
export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Pull every wine with a drink window. Filter snooze + 86'd at the DB
  // layer; filter "should alert" in Node via the status helper (single
  // source of truth shared with cellar shell counts).
  const nowIso = new Date().toISOString();
  const { data: wines, error: wineErr } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, drink_window_start, drink_window_end, peak_year, rating, rating_source, review_excerpt",
    )
    .eq("restaurant_id", restaurantId)
    .eq("is_eightysixed", false)
    .not("drink_window_end", "is", null)
    .or(`alert_snoozed_until.is.null,alert_snoozed_until.lt.${nowIso}`);

  if (wineErr) {
    Sentry.captureException(wineErr, {
      tags: { surface: "insights-drink-alerts", phase: "wines-fetch" },
      extra: { restaurantId },
    });
    return NextResponse.json(
      { error: "Failed to fetch alerts." },
      { status: 500 },
    );
  }

  // Apply the alert-trigger predicate. Doing this in Node keeps the
  // calculus consistent with the cellar shell counts (same helper).
  const triggered = (wines ?? []).filter((w) =>
    shouldTriggerAlert(w.drink_window_end),
  );

  if (triggered.length === 0) {
    return NextResponse.json({ alerts: [] });
  }

  // Aggregate bottle counts from inventory_items. Single batch query
  // for all triggered wines.
  const wineIds = triggered.map((w) => w.id);
  const { data: invRows, error: invErr } = await supabase
    .from("inventory_items")
    .select("wine_id, quantity, bin_location")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wineIds);

  if (invErr) {
    Sentry.captureException(invErr, {
      tags: { surface: "insights-drink-alerts", phase: "inventory-fetch" },
      extra: { restaurantId, wineIds: wineIds.length },
    });
    return NextResponse.json(
      { error: "Failed to fetch inventory." },
      { status: 500 },
    );
  }

  // Aggregate per wine_id. Also pick the first bin_location (multi-bin
  // wines are uncommon; the briefing card only displays one anyway).
  const aggByWine = new Map<string, { count: number; bin: string | null }>();
  for (const row of invRows ?? []) {
    if (!row.wine_id) continue;
    const prev = aggByWine.get(row.wine_id) ?? { count: 0, bin: null };
    prev.count += row.quantity ?? 0;
    if (!prev.bin && row.bin_location) prev.bin = row.bin_location;
    aggByWine.set(row.wine_id, prev);
  }

  // Filter wines with no bottles and shape the response.
  const alerts = triggered
    .map((w) => {
      const inv = aggByWine.get(w.id);
      if (!inv || inv.count <= 0) return null;
      return {
        wine_id: w.id,
        name: w.name,
        producer: w.producer,
        vintage: w.vintage,
        drink_window_start: w.drink_window_start,
        drink_window_end: w.drink_window_end,
        peak_year: w.peak_year,
        rating: w.rating,
        rating_source: w.rating_source,
        review_excerpt: w.review_excerpt,
        bottle_count: inv.count,
        bin_location: inv.bin,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    // Sort most urgent first (smallest yearsLeft, then alphabetical).
    .sort((a, b) => {
      const aYears = (a.drink_window_end ?? 9999) - new Date().getFullYear();
      const bYears = (b.drink_window_end ?? 9999) - new Date().getFullYear();
      if (aYears !== bYears) return aYears - bYears;
      return a.producer.localeCompare(b.producer);
    });

  return NextResponse.json({ alerts });
}
