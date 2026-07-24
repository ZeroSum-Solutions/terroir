import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
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
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

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
    if (fetchErr) throw fetchErr;

    const eligible = (wines ?? []).filter(
      (
        wine,
      ): wine is {
        id: string;
        lwin_id: string;
        retail_refreshed_at: string | null;
      } => typeof wine.lwin_id === "string",
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

    // Pull invoice costs for sanity-filter, batched. Proceeding without
    // these costs would bypass the wrong-wine price sanity check.
    const wineIds = eligible.map((wine) => wine.id);
    const { data: invoiceRows, error: invoiceError } = await supabase
      .from("inventory_items")
      .select("wine_id, unit_cost, currency, added_via, added_at")
      .eq("restaurant_id", restaurantId)
      .in("wine_id", wineIds)
      .eq("added_via", "invoice_scan")
      .gt("unit_cost", 0)
      .or("currency.is.null,currency.eq.USD")
      .order("added_at", { ascending: false });
    if (invoiceError) throw invoiceError;

    const costByWine = new Map<string, number>();
    for (const row of invoiceRows ?? []) {
      if (
        !row.wine_id ||
        row.unit_cost <= 0 ||
        (row.currency != null && row.currency.toUpperCase() !== "USD")
      ) {
        continue;
      }
      if (!costByWine.has(row.wine_id)) {
        costByWine.set(row.wine_id, row.unit_cost);
      }
    }

    // Concurrency-limited fan-out. A null result is an expected provider
    // miss and is counted as skipped.
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
          if (!result) return null;
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
        } else {
          skipped += 1;
        }
      }
    }

    // Count refreshes only after the tenant-scoped persistence succeeds.
    // Individual write failures stay isolated so one wine cannot discard
    // successful work for the rest of the batch.
    for (const row of updatePayload) {
      const { data: updatedWine, error: writeError } = await supabase
        .from("wines")
        .update({
          retail_min: row.retail_min,
          retail_max: row.retail_max,
          retail_median: row.retail_median,
          retail_retailer_count: row.retail_retailer_count,
          retail_refreshed_at: row.retail_refreshed_at,
        })
        .eq("id", row.id)
        .eq("restaurant_id", restaurantId)
        .select("id")
        .maybeSingle();

      if (writeError || !updatedWine) {
        Sentry.captureException(
          writeError ??
            new Error("Retail refresh update did not affect a tenant wine."),
          {
            tags: { surface: "wines-refresh-batch", phase: "db-write" },
            extra: { wineId: row.id, restaurantId },
          },
        );
        skipped += 1;
        continue;
      }

      refreshed += 1;
    }

    return NextResponse.json({
      total: eligible.length,
      refreshed,
      skipped,
      // Stop the client loop when a full page makes no progress. Without
      // durable retry backoff, immediately retrying that same page would
      // only burn provider quota again.
      hasMore: eligible.length >= REFRESH_BATCH_LIMIT && refreshed > 0,
      apiKeyConfigured: true,
    });
  });
}
