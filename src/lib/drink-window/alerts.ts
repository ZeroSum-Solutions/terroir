/**
 * BND-039 — shared drink-window alerts fetcher.
 *
 * Single source of truth for the alerts pipeline. Used by:
 *   • /api/insights/drink-window-alerts (server-side API for client refetch)
 *   • src/app/(app)/insights/page.tsx (server-component direct call)
 *
 * Code-quality-review finding 5: previously the body was duplicated in
 * both call sites. This module is the canonical implementation.
 *
 * Filters mirror exactly:
 *   • drink_window_end is non-null
 *   • alert_snoozed_until is null OR expired
 *   • is_eightysixed = false (not actionable when sold-out)
 *   • bottle_count > 0 (no point alerting on wines we don't have)
 *
 * Does NOT filter on the alert-trigger predicate at the DB layer — that
 * lives in @/lib/drink-window/status so cellar shell counts and list
 * filters never drift from this fetcher.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { shouldTriggerAlert } from "./status";

export type DrinkWindowAlertRow = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  drink_window_start: number | null;
  drink_window_end: number | null;
  peak_year: number | null;
  rating: number | null;
  rating_source: string | null;
  review_excerpt: string | null;
  bottle_count: number;
  bin_location: string | null;
};

/**
 * Fetch all drink-window alerts for a restaurant. Returns the array
 * sorted by urgency (closest to window close first, then alphabetical
 * by producer for stable order).
 *
 * Returns an empty array on no-alerts (not an error). Throws only on
 * unrecoverable DB errors — callers should catch and 500.
 */
export async function fetchDrinkWindowAlerts(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<DrinkWindowAlertRow[]> {
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

  if (wineErr) throw wineErr;

  // Apply alert-trigger predicate in Node via the shared helper. Same
  // calculus as cellar shell counts — drift-proof by construction.
  const triggered = (wines ?? []).filter((w) =>
    shouldTriggerAlert(w.drink_window_end),
  );
  if (triggered.length === 0) return [];

  // Aggregate inventory counts per wine in a single batch.
  const wineIds = triggered.map((w) => w.id);
  const { data: invRows, error: invErr } = await supabase
    .from("inventory_items")
    .select("wine_id, quantity, bin_location")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wineIds);

  if (invErr) throw invErr;

  const aggByWine = new Map<string, { count: number; bin: string | null }>();
  for (const row of invRows ?? []) {
    if (!row.wine_id) continue;
    const prev = aggByWine.get(row.wine_id) ?? { count: 0, bin: null };
    prev.count += row.quantity ?? 0;
    if (!prev.bin && row.bin_location) prev.bin = row.bin_location;
    aggByWine.set(row.wine_id, prev);
  }

  const alerts: DrinkWindowAlertRow[] = [];
  for (const w of triggered) {
    const inv = aggByWine.get(w.id);
    if (!inv || inv.count <= 0) continue;
    alerts.push({
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
    });
  }

  // Most urgent first. Code-quality-review finding 6: hoist currentYear
  // out of the comparator so it isn't recomputed N×log(N) times.
  const currentYear = new Date().getFullYear();
  alerts.sort((a, b) => {
    const aY = (a.drink_window_end ?? 9999) - currentYear;
    const bY = (b.drink_window_end ?? 9999) - currentYear;
    if (aY !== bY) return aY - bY;
    return a.producer.localeCompare(b.producer);
  });
  return alerts;
}
