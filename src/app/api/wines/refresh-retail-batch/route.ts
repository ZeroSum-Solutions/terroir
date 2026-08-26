import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { fetchRetailPrices } from "@/lib/wine-intelligence/wine-searcher";

export const runtime = "nodejs";

/**
 * BND-040 — POST /api/wines/refresh-retail-batch
 *
 * Bulk Wine-Searcher refresh for the cellar. Iterates over wines that:
 *   • have lwin_id (LWIN-keyed lookup is the only way in)
 *   • are stale (retail_refreshed_at is null OR older than 7 days)
 *
 * Per-request cap to avoid burning Wine-Searcher trial-tier quota in one
 * click — mirrors the BND-039 enrich-cellar pattern. The Insights button
 * loops until hasMore=false to drain the backlog incrementally.
 *
 * Auth: owner+manager only (architect finding 8 — staff misuse burns
 * paid quota).
 */
const REFRESH_BATCH_LIMIT = 50;
const REFRESH_CONCURRENCY = 5;
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    return Errors.forbidden("Refreshing retail data requires owner or manager role.");
  }

  // Audit-finding M1: surface configuration status so the
  // RefreshRetailButton can stop reporting "0 wines refreshed" silently
  // when the cause is just a missing env var. Owner-only message; staff
  // can't even reach this endpoint via role guard above.
  const apiKeyConfigured = !!process.env.WINE_SEARCHER_API_KEY;
  if (!apiKeyConfigured) {
    return NextResponse.json({
      total: 0,
      refreshed: 0,
      skipped: 0,
      hasMore: false,
      apiKeyConfigured: false,
      message:
        "Wine-Searcher API key is not configured. Set WINE_SEARCHER_API_KEY in Railway environment variables to enable retail-price enrichment.",
    });
  }

  // Find wines that need refresh: have LWIN, no retail data OR data older
  // than 7 days. Bound by REFRESH_BATCH_LIMIT to keep request thread snappy
  // and respect Wine-Searcher quota.
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: wines, error: fetchErr } = await supabase
    .from("wines")
    .select("id, lwin_id, retail_refreshed_at")
    .eq("restaurant_id", restaurantId)
    .not("lwin_id", "is", null)
    .or(`retail_refreshed_at.is.null,retail_refreshed_at.lt.${staleCutoff}`)
    .limit(REFRESH_BATCH_LIMIT);

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: { surface: "wines-refresh-batch", phase: "fetch" },
      extra: { restaurantId },
    });
    return Errors.internal("Lookup failed.");
  }

  const eligible = (wines ?? []).filter(
    (w): w is { id: string; lwin_id: string; retail_refreshed_at: string | null } =>
      typeof w.lwin_id === "string",
  );

  if (eligible.length === 0) {
    return NextResponse.json({
      total: 0,
      refreshed: 0,
      skipped: 0,
      hasMore: false,
      apiKeyConfigured: true,
    });
  }

  // Pull invoice costs for sanity-filter, batched.
  const wineIds = eligible.map((w) => w.id);
  const { data: invRows } = await supabase
    .from("inventory_items")
    .select("wine_id, unit_cost, added_at")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wineIds)
    .order("added_at", { ascending: false });

  const costByWine = new Map<string, number>();
  for (const r of invRows ?? []) {
    if (!r.wine_id || r.unit_cost == null) continue;
    if (!costByWine.has(r.wine_id)) costByWine.set(r.wine_id, r.unit_cost);
  }

  // Concurrency-limited fan-out. Each call gracefully nulls on failure
  // (rate-limit, sanity-filter, parse error) — Wine-Searcher client logs
  // the specific reason to Sentry so ops sees the breakdown.
  let refreshed = 0;
  let skipped = 0;
  const updatePayload: Array<{
    id: string;
    retail_min: number;
    retail_max: number;
    retail_median: number;
    retail_retailer_count: number;
    retail_refreshed_at: string;
  }> = [];

  for (let i = 0; i < eligible.length; i += REFRESH_CONCURRENCY) {
    const slice = eligible.slice(i, i + REFRESH_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (wine) => {
        const result = await fetchRetailPrices({
          lwinId: wine.lwin_id,
          invoiceCost: costByWine.get(wine.id),
        });
        // The frozen schema cannot record price basis. Keep average-only
        // values out of retail_median so every persisted consumer sees a
        // true median.
        if (!result || result.retailMedianBasis !== "median") return null;
        return {
          id: wine.id,
          retail_min: result.retailMin,
          retail_max: result.retailMax,
          retail_median: result.retailMedian,
          retail_retailer_count: result.retailerCount,
          retail_refreshed_at: result.refreshedAt.toISOString(),
        };
      }),
    );
    for (const row of settled) {
      if (row) {
        updatePayload.push(row);
        refreshed += 1;
      } else {
        skipped += 1;
      }
    }
  }

  // Write back. We could batch-update via RPC but row-level UPDATE is fine
  // here — at most REFRESH_BATCH_LIMIT (50) rows per call. If profiling
  // shows latency we can add an RPC later.
  for (const row of updatePayload) {
    const { error: writeErr } = await supabase
      .from("wines")
      .update({
        retail_min: row.retail_min,
        retail_max: row.retail_max,
        retail_median: row.retail_median,
        retail_retailer_count: row.retail_retailer_count,
        retail_refreshed_at: row.retail_refreshed_at,
      })
      .eq("id", row.id)
      .eq("restaurant_id", restaurantId);
    if (writeErr) {
      Sentry.captureException(writeErr, {
        tags: { surface: "wines-refresh-batch", phase: "db-write" },
        extra: { wineId: row.id, restaurantId },
      });
      // Don't abort the batch on a single write failure — partial success
      // is preferred over all-or-nothing.
    }
  }

  return NextResponse.json({
    total: eligible.length,
    refreshed,
    skipped,
    // Client should re-invoke until hasMore=false to drain stale wines.
    hasMore: eligible.length >= REFRESH_BATCH_LIMIT,
    apiKeyConfigured: true,
  });
}
